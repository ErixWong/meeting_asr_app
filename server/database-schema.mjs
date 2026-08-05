export function initializeDatabase(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_settings (
      item_section TEXT NOT NULL,
      item_mark TEXT NOT NULL,
      item_title TEXT NOT NULL,
      item_description TEXT NOT NULL DEFAULT '',
      item_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_section, item_mark)
    );

    CREATE TABLE IF NOT EXISTS llm_prompt_templates (
      id TEXT PRIMARY KEY,
      template_key TEXT NOT NULL UNIQUE,
      template_name TEXT NOT NULL,
      template_type TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asr_hotwords (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL UNIQUE,
      weight INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT,
      department TEXT,
      external_user_id TEXT,
      password_hash TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      role_key TEXT NOT NULL UNIQUE,
      role_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_file_name TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL,
      status_updated_at TEXT NOT NULL,
      last_error_message TEXT,
      created_by_user_id TEXT NOT NULL,
      created_by_user_name TEXT NOT NULL,
      created_by_user_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS meeting_asr_results (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      asr_provider TEXT NOT NULL,
      asr_setting_mark TEXT NOT NULL,
      asr_config_snapshot TEXT NOT NULL,
      capture_session_id TEXT NOT NULL,
      result_format TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meeting_llm_results (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      input_transcript_snapshot TEXT NOT NULL,
      llm_setting_mark TEXT NOT NULL,
      prompt_template_id TEXT NOT NULL,
      generation_config_snapshot TEXT NOT NULL,
      generation_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      result_type TEXT NOT NULL,
      result_title TEXT NOT NULL,
      raw_prompt TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      result_markdown TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY (prompt_template_id) REFERENCES llm_prompt_templates(id) ON DELETE RESTRICT,
      UNIQUE (meeting_id, version_no)
    );

    CREATE TABLE IF NOT EXISTS meeting_send_records (
      id TEXT PRIMARY KEY,
      meeting_llm_result_id TEXT NOT NULL,
      mail_template_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      to_recipients_json TEXT NOT NULL,
      cc_recipients_json TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      body_html TEXT NOT NULL,
      status TEXT NOT NULL,
      mail_setting_mark TEXT NOT NULL,
      mail_config_snapshot TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      sent_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      FOREIGN KEY (meeting_llm_result_id) REFERENCES meeting_llm_results(id) ON DELETE CASCADE,
      FOREIGN KEY (sent_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS asr_capture_sessions (
      capture_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      asr_provider TEXT NOT NULL,
      asr_config_snapshot TEXT NOT NULL,
      hotwords_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asr_capture_events (
      id TEXT PRIMARY KEY,
      capture_session_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE(capture_session_id, sequence_no),
      FOREIGN KEY (capture_session_id)
        REFERENCES asr_capture_sessions(capture_session_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_account_name TEXT NOT NULL,
      actor_display_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      resource_name TEXT,
      request_id TEXT,
      result TEXT NOT NULL,
      error_message TEXT,
      before_snapshot TEXT,
      after_snapshot TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_meeting_asr_results_meeting_created
      ON meeting_asr_results(meeting_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_meeting_send_records_llm_created
      ON meeting_send_records(meeting_llm_result_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_asr_capture_sessions_expires
      ON asr_capture_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
      ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_user_roles_role
      ON user_roles(role_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created
      ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
      ON audit_logs(resource_type, resource_id);
  `);

  migrateMeetingLlmSchema(database);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_meeting_llm_results_meeting_version_created
      ON meeting_llm_results(meeting_id, version_no, created_at);
  `);
}

function migrateMeetingLlmSchema(database) {
  const columns = database.prepare("PRAGMA table_info(meeting_llm_results)").all();
  if (!columns.length || columns.some((column) => column.name === "meeting_id")) return;

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("ALTER TABLE meeting_send_records RENAME TO meeting_send_records_legacy");
    database.exec("ALTER TABLE meeting_llm_results RENAME TO meeting_llm_results_legacy");

    database.exec(`
      CREATE TABLE meeting_llm_results (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        input_transcript_snapshot TEXT NOT NULL,
        llm_setting_mark TEXT NOT NULL,
        prompt_template_id TEXT NOT NULL,
        generation_config_snapshot TEXT NOT NULL,
        generation_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        result_type TEXT NOT NULL,
        result_title TEXT NOT NULL,
        raw_prompt TEXT NOT NULL,
        raw_response TEXT NOT NULL,
        result_markdown TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
        FOREIGN KEY (prompt_template_id) REFERENCES llm_prompt_templates(id) ON DELETE RESTRICT,
        UNIQUE (meeting_id, version_no)
      )
    `);

    database.exec(`
      CREATE TABLE meeting_send_records (
        id TEXT PRIMARY KEY,
        meeting_llm_result_id TEXT NOT NULL,
        mail_template_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        to_recipients_json TEXT NOT NULL,
        cc_recipients_json TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        body_html TEXT NOT NULL,
        status TEXT NOT NULL,
        mail_setting_mark TEXT NOT NULL,
        mail_config_snapshot TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        provider_message_id TEXT,
        error_message TEXT,
        sent_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        FOREIGN KEY (meeting_llm_result_id) REFERENCES meeting_llm_results(id) ON DELETE CASCADE,
        FOREIGN KEY (sent_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
      )
    `);

    database.exec(`
      INSERT INTO meeting_llm_results (
        id, meeting_id, input_transcript_snapshot, llm_setting_mark, prompt_template_id,
        generation_config_snapshot, generation_mode, status, version_no, result_type,
        result_title, raw_prompt, raw_response, result_markdown, error_message, created_at
      )
      SELECT
        legacy.id,
        asr.meeting_id,
        COALESCE(asr.normalized_text, ''),
        legacy.llm_setting_mark,
        legacy.prompt_template_id,
        legacy.generation_config_snapshot,
        legacy.generation_mode,
        legacy.status,
        legacy.version_no,
        legacy.result_type,
        legacy.result_title,
        legacy.raw_prompt,
        legacy.raw_response,
        legacy.result_markdown,
        legacy.error_message,
        legacy.created_at
      FROM meeting_llm_results_legacy legacy
      INNER JOIN meeting_asr_results asr ON asr.id = legacy.meeting_asr_result_id
    `);

    database.exec(`
      INSERT INTO meeting_send_records (
        id, meeting_llm_result_id, mail_template_type, subject,
        to_recipients_json, cc_recipients_json, body_markdown, body_html,
        status, mail_setting_mark, mail_config_snapshot, provider_type,
        provider_message_id, error_message, sent_by_user_id, created_at, sent_at
      )
      SELECT
        legacy.id, legacy.meeting_llm_result_id, legacy.mail_template_type, legacy.subject,
        legacy.to_recipients_json, legacy.cc_recipients_json, legacy.body_markdown, legacy.body_html,
        legacy.status, legacy.mail_setting_mark, legacy.mail_config_snapshot, legacy.provider_type,
        legacy.provider_message_id, legacy.error_message, legacy.sent_by_user_id,
        legacy.created_at, legacy.sent_at
      FROM meeting_send_records_legacy legacy
      INNER JOIN meeting_llm_results current_result
        ON current_result.id = legacy.meeting_llm_result_id
    `);

    database.exec("DROP TABLE meeting_send_records_legacy");
    database.exec("DROP TABLE meeting_llm_results_legacy");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
