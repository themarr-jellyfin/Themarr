import os
import re
import time
from datetime import timedelta

from flask import render_template, jsonify, request, send_file, session, redirect, url_for, make_response
from werkzeug.exceptions import HTTPException

from core.config import load_config, SERVER_MODE, MEDIA_ROOT, BACKUP_DIR, APP_VERSION
from core import updates, backup
from core.safety import UnsafeMediaOperation, check_media_read, check_theme_write, is_theme_file
from api_controller import save_uploaded_backup, local_cover, LOCAL_COVER_NAMES, LOCAL_ART_NAMES

PUBLIC_ENDPOINTS = {'login', 'static'}


def _safe_next(target):
    """Only same-site paths are accepted after login"""
    return target if target and target.startswith('/') and not target.startswith('//') else '/'


def register_auth(app):
    """Server mode: every page and API call needs a signed-in Jellyfin administrator"""
    from core.auth import get_secret_key, authenticate_jellyfin_admin

    app.secret_key = get_secret_key()
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024 * 1024,  # backup uploads
    )

    @app.before_request
    def require_login():
        if request.endpoint in PUBLIC_ENDPOINTS or session.get('user'):
            return None
        if request.path.startswith('/api/'):
            return jsonify({"success": False, "status": "error", "message": "Login required."}), 401
        return redirect(url_for('login', next=request.full_path.rstrip('?')))

    @app.route('/login', methods=['GET', 'POST'])
    def login():
        next_url = _safe_next(request.values.get('next', '/'))
        if request.method == 'GET':
            return render_template('login.html', error=None, next_url=next_url)

        result = authenticate_jellyfin_admin(request.form.get('username', '').strip(), request.form.get('password', ''))
        if not result["ok"]:
            time.sleep(1)  # slows down password guessing
            print(f"[AUTH] Failed login for '{request.form.get('username', '')}': {result['message']}")
            return render_template('login.html', error=result["message"], next_url=next_url), 401

        session.permanent = True
        session['user'] = result["name"]
        print(f"[AUTH] {result['name']} signed in.")
        return redirect(next_url)

    @app.route('/logout', methods=['POST'])
    def logout():
        session.clear()
        return redirect(url_for('login'))

def register_routes(app, api_system):
    if SERVER_MODE:
        register_auth(app)

    def body():
        return request.get_json(force=True, silent=True) or {}

    @app.errorhandler(UnsafeMediaOperation)
    def blocked_media_operation(error):
        print(f"[SAFETY] 🛡️ {error}")
        return jsonify({"success": False, "status": "error", "message": str(error)}), 403

    @app.route('/')
    def home():
        return render_template('index.html', server_mode=SERVER_MODE)

    @app.route('/api/app_info', methods=['GET'])
    def api_app_info():
        return jsonify({"server_mode": SERVER_MODE, "media_root": MEDIA_ROOT, "version": APP_VERSION,
                        "user": session.get('user') if SERVER_MODE else None})

    # ---------------- Settings ----------------
    @app.route('/api/get_settings', methods=['GET'])
    def api_get_settings():
        return jsonify(api_system.get_settings())

    @app.route('/api/save_settings', methods=['POST'])
    def api_save_settings():
        data = dict(api_system.get_settings(), **body())
        data.pop('library_folders', None)
        data['library_folders'] = load_config().get('library_folders', [])
        api_system.save_settings(data)
        return jsonify({"success": True})

    @app.route('/api/library/folders', methods=['GET', 'POST'])
    def api_library_folders():
        if request.method == 'POST':
            return jsonify(api_system.set_library_folders(body().get('folders', [])))
        return jsonify({"success": True, "folders": api_system.get_library_folders()})

    @app.route('/api/select_folder', methods=['POST'])
    def api_select_folder():
        return jsonify(api_system.select_folder())

    @app.route('/api/browse_folders', methods=['POST'])
    def api_browse_folders():
        return jsonify(api_system.browse_media_folders(body().get('folder')))

    @app.route('/api/suggest_folders', methods=['POST'])
    def api_suggest_folders():
        return jsonify(api_system.suggest_media_folders(body().get('text', '')))

    @app.route('/api/test_jellyfin', methods=['POST'])
    def api_test_jellyfin():
        data = body()
        return jsonify(api_system.test_jellyfin(data.get('url', ''), data.get('api_key', '')))

    @app.route('/api/jellyfin/install_buttons', methods=['POST'])
    def api_install_jellyfin_buttons():
        return jsonify(api_system.install_jellyfin_buttons())

    @app.route('/jellyfin/themarr-buttons.js')
    def jellyfin_buttons_script():
        # The script ready to paste into JavaScript Injector by hand
        return api_system.jellyfin_buttons_script(), 200, {'Content-Type': 'text/plain; charset=utf-8'}

    # ---------------- Updates ----------------
    @app.route('/api/updates', methods=['GET'])
    def api_updates():
        return jsonify(updates.check_for_update(force=request.args.get('force') == '1'))

    @app.route('/api/updates/install', methods=['POST'])
    def api_updates_install():
        return jsonify(updates.install_update())

    @app.route('/api/updates/status', methods=['GET'])
    def api_updates_status():
        return jsonify(updates.install_state)

    # ---------------- Library ----------------
    @app.route('/api/library', methods=['GET'])
    def api_library():
        return jsonify(api_system.library_overview(fresh=request.args.get('fresh') == '1'))

    @app.route('/api/media', methods=['POST'])
    def api_media():
        return jsonify(api_system.media_details(body().get('path', '')))

    @app.route('/api/media/action', methods=['POST'])
    def api_media_action():
        data = body()
        return jsonify(api_system.run_media_action(data.get('folders', []), data.get('action', '')))

    @app.route('/api/jellyfin/resolve_item', methods=['POST'])
    def api_resolve_jellyfin_item():
        return jsonify(api_system.resolve_jellyfin_item(body().get('item_id', '')))

    @app.route('/api/jellyfin/image/<item_id>')
    def api_jellyfin_image(item_id):
        if not re.fullmatch(r'[0-9a-fA-F]{32}', item_id):
            return "Invalid item", 400
        image = api_system.jellyfin_image(item_id, request.args.get('type', 'Primary'))
        if not image:
            return "No image", 404
        response = make_response(image[0])
        response.headers['Content-Type'] = image[1]
        response.headers['Cache-Control'] = 'private, max-age=86400'
        return response

    @app.route('/api/media/cover')
    def api_media_cover():
        folder = request.args.get('path', '')
        check_media_read(folder or '.')
        # kind: backdrop or logo instead of the poster
        names = LOCAL_ART_NAMES.get(request.args.get('kind'), LOCAL_COVER_NAMES)
        cover = local_cover(folder, names) if folder and os.path.isdir(folder) else None
        if not cover:
            return "No cover", 404
        return send_file(cover, max_age=86400)

    @app.route('/api/library/stream')
    def stream_local_file():
        file_path = request.args.get('path')
        if not file_path or not os.path.exists(file_path):
            return "File not found", 404
        if not is_theme_file(file_path):
            return "Only theme files can be streamed", 403
        check_media_read(file_path)
        return send_file(file_path, mimetype="audio/mpeg")

    @app.route('/api/library/process', methods=['POST'])
    def process_library_track():
        data = body()
        start_time = data.get('startTime', '')
        end_time = data.get('endTime', '')
        normalize = data.get('normalize', True)
        fades = data.get('fades', True)

        config = load_config()
        fx = config.get('audio_fx', {})
        audio_effects = {
            "enabled": fades,
            "remove_silence": False if (start_time or end_time) else (fades and fx.get('remove_silence', False)),
            "fade_in": float(fx.get('fade_in', 0)) if fades else 0,
            "fade_out": float(fx.get('fade_out', 0)) if fades else 0,
            "start_time": start_time or None,
            "end_time": end_time or None
        }
        return jsonify(api_system.process_local_file(
            file_path=data.get('file_path', ''),
            target_lufs=float(config.get('lufs', -24)),
            audio_effects=audio_effects,
            normalize_enabled=normalize,
            tag_enabled=data.get('tag', True),
        ))

    @app.route('/api/library/rename', methods=['POST'])
    def rename_library_track():
        data = body()
        return jsonify(api_system.rename_track(data.get('file_path', ''), data.get('new_name', '')))

    @app.route('/api/library/move', methods=['POST'])
    def move_library_track():
        data = body()
        return jsonify(api_system.move_track(data.get('file_path', ''), data.get('destination', ''), data.get('new_name', '')))

    @app.route('/api/library/retag', methods=['POST'])
    def retag_library_track():
        return jsonify(api_system.retag_track(body().get('file_path', '')))

    @app.route('/api/library/delete', methods=['POST'])
    def delete_library_track():
        file_path = body().get('file_path', '')
        if not file_path or not os.path.exists(file_path):
            return jsonify({"success": False, "message": "File not found."})
        if not is_theme_file(file_path):
            return jsonify({"success": False, "message": "Only theme files can be deleted."})
        check_theme_write(file_path, "delete")
        os.remove(file_path)
        folder = os.path.dirname(file_path)
        if os.path.basename(folder).lower() == 'theme-music' and not os.listdir(folder):
            os.rmdir(folder)
        print(f"[LIBRARY] 🗑️ Deleted {file_path}")
        return jsonify({"success": True, "message": "Theme deleted."})

    # ---------------- YouTube ----------------
    @app.route('/api/search_youtube', methods=['POST'])
    def api_search_youtube():
        return jsonify(api_system.search_youtube(body().get('query', '')))

    @app.route('/api/get_stream_info', methods=['POST'])
    def api_stream_info():
        return jsonify(api_system.get_stream_info(body().get('url')))

    @app.route('/api/library/assistant/suggestions', methods=['POST'])
    def api_assistant_suggestions():
        data = body()
        if data.get('folder_path'):
            check_media_read(data['folder_path'])
        return jsonify(api_system.get_media_theme_suggestions(data.get('folder_name', ''), data.get('folder_path')))

    @app.route('/api/sources/suggested', methods=['POST'])
    def api_suggested_theme():
        data = body()
        folder_path = data.get('folder_path') or ''
        if folder_path:
            check_media_read(folder_path)
        theme = api_system.get_suggested_theme(data.get('folder_name') or os.path.basename(folder_path), folder_path or None)
        return jsonify({"success": True, "suggestion": theme})

    # ---------------- Queue and activity ----------------
    @app.route('/api/queue', methods=['GET'])
    def api_queue():
        return jsonify(api_system.queue_list())

    @app.route('/api/queue/add', methods=['POST'])
    def api_queue_add():
        data = body()
        return jsonify(api_system.queue_add(data.get('media_folder', ''), data.get('items', [])))

    @app.route('/api/queue/remove', methods=['POST'])
    def api_queue_remove():
        return jsonify(api_system.queue_remove(body().get('id')))

    @app.route('/api/queue/retry', methods=['POST'])
    def api_queue_retry():
        return jsonify(api_system.queue_retry(body().get('id')))

    @app.route('/api/queue/clear', methods=['POST'])
    def api_queue_clear():
        return jsonify(api_system.queue_clear_finished())

    @app.route('/api/queue/pause', methods=['POST'])
    def api_queue_pause():
        return jsonify(api_system.queue_pause(body().get('paused', True)))

    @app.route('/api/status', methods=['GET'])
    def api_status():
        return jsonify(api_system.get_status())

    # ---------------- Backup ----------------
    @app.route('/api/library/backup/export', methods=['POST'])
    def api_export_backup():
        data = body()
        return jsonify(api_system.export_media_backup(base_path=data.get('base_path', ''), save_path=data.get('save_path', '')))

    @app.route('/api/library/backup/save_dialog', methods=['POST'])
    def api_backup_save_dialog():
        return jsonify(api_system.choose_backup_destination(base_path=body().get('base_path', '')))

    @app.route('/api/library/backup/status', methods=['GET'])
    def api_backup_status():
        return jsonify(backup.state)

    @app.route('/api/library/backup/cancel', methods=['POST'])
    def api_backup_cancel():
        backup.cancel()
        return jsonify({"success": True})

    @app.route('/api/library/backup/download')
    def api_download_backup():
        name = os.path.basename(request.args.get('name', ''))
        path = os.path.join(BACKUP_DIR, name)
        if not backup.NAME.fullmatch(name) or not os.path.isfile(path):
            return "Backup not found", 404
        return send_file(path, as_attachment=True, download_name=name)

    @app.route('/api/library/backup/select_file', methods=['POST'])
    def api_select_backup_file():
        return jsonify(api_system.select_backup_file())

    @app.route('/api/library/backup/upload', methods=['POST'])
    def api_upload_backup():
        upload = request.files.get('file')
        if not upload or not upload.filename.lower().endswith('.zip'):
            return jsonify({"success": False, "message": "Please choose a .zip backup file."})
        return jsonify({"success": True, "file_path": save_uploaded_backup(upload)})

    @app.route('/api/library/backup/analyze', methods=['POST'])
    def api_analyze_backup():
        data = body()
        return jsonify(api_system.analyze_backup(zip_path=data.get('zip_path', ''), base_path=data.get('base_path', '')))

    @app.route('/api/library/backup/restore', methods=['POST'])
    def api_restore_backup():
        data = body()
        return jsonify(api_system.restore_backup(
            zip_path=data.get('zip_path', ''),
            base_path=data.get('base_path', ''),
            decision=data.get('decision', 'cancel'),
        ))

    @app.errorhandler(Exception)
    def unexpected_error(error):
        if isinstance(error, HTTPException):
            return error
        print(f"[SERVER] ❌ {request.path}: {error}")
        if request.path.startswith('/api/'):
            return jsonify({"success": False, "status": "error", "message": f"Server error: {error}"}), 500
        return "Server error", 500
