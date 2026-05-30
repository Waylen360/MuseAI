use serde_json::{json, Value};
use std::fs;
use tauri::AppHandle;
use uuid::Uuid;

use super::*;
use crate::llm::*;
use crate::models::*;
use crate::utils::*;
use crate::ActiveStreams;

#[tauri::command]
pub fn list_agent_sessions(
    app: AppHandle,
    prefix: Option<String>,
) -> Result<Vec<AgentSessionSummary>, String> {
    let dir = agent_sessions_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut summaries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<AgentSessionRecord>(&text) else {
            continue;
        };
        if let Some(ref p) = prefix {
            if !record.id.starts_with(p) {
                continue;
            }
        }
        if record.id.starts_with("partner-session-") && record.is_archived != Some(true) {
            continue;
        }
        summaries.push(AgentSessionSummary {
            id: record.id,
            title: record.title,
            saved_at: record.saved_at,
        });
    }

    summaries.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(summaries)
}
#[tauri::command]
pub fn load_agent_session(app: AppHandle, id: String) -> Result<AgentSessionRecord, String> {
    let path = agent_session_path(&app, &id)?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn save_agent_session(
    app: AppHandle,
    mut session: AgentSessionRecord,
) -> Result<AgentSessionSummary, String> {
    let dir = agent_sessions_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    session.saved_at = now_millis()?;
    let path = agent_session_path(&app, &session.id)?;
    let text = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(AgentSessionSummary {
        id: session.id,
        title: session.title,
        saved_at: session.saved_at,
    })
}
#[tauri::command]
pub async fn summarize_text(request: SummarizeRequest) -> Result<String, String> {
    let client = reqwest::Client::new();
    let system_prompt =
        "请使用用户输入的消息，总结用户意图，不超过15个字。务必注意，是总结用户意图，而不是回应用户的消息";
    let user_prompt = format!("通过以下信息，总结意图，不超过15个字：{}", request.text);
    let max_tokens = request.max_output_tokens.unwrap_or(64).min(128);

    match request.model_interface.as_str() {
        "Anthropic-compatible" => {
            let endpoint = build_anthropic_endpoint(&request.base_url);
            let body = json!({
                "model": request.model,
                "messages": [{"role": "user", "content": user_prompt}],
                "system": system_prompt,
                "stream": false,
                "temperature": request.temperature.unwrap_or(0.3),
                "max_tokens": max_tokens,
            });

            let response = client
                .post(&endpoint)
                .header("x-api-key", &request.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                return Err(format!("Anthropic 接口请求失败：{} {}", status, body_text));
            }

            let json: Value = response.json().await.map_err(|e| e.to_string())?;
            let content = json
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|item| item.get("type") == Some(&json!("text")))
                })
                .and_then(|text_block| text_block.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .trim_matches(|c| {
                    c == '"' || c == '\'' || c == '「' || c == '」' || c == '『' || c == '』'
                })
                .to_string();

            if content.is_empty() {
                return Err(String::from("生成标题为空"));
            }
            Ok(content)
        }
        _ => {
            let endpoint = build_openai_endpoint(&request.base_url);
            let messages = vec![
                json!({"role": "system", "content": system_prompt}),
                json!({"role": "user", "content": user_prompt}),
            ];
            let body = json!({
                "model": request.model,
                "messages": messages,
                "stream": false,
                "temperature": request.temperature.unwrap_or(0.3),
                "max_tokens": max_tokens,
            });

            let response = client
                .post(&endpoint)
                .bearer_auth(&request.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                return Err(format!("OpenAI 兼容接口请求失败：{} {}", status, body_text));
            }

            let json: Value = response.json().await.map_err(|e| e.to_string())?;
            let content = json
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|msg| msg.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .trim_matches(|c| {
                    c == '"' || c == '\'' || c == '「' || c == '」' || c == '『' || c == '』'
                })
                .to_string();

            if content.is_empty() {
                return Err(String::from("生成标题为空"));
            }
            Ok(content)
        }
    }
}
#[tauri::command]
pub fn update_agent_session_title(
    app: AppHandle,
    id: String,
    title: String,
) -> Result<AgentSessionSummary, String> {
    let path = agent_session_path(&app, &id)?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut record: AgentSessionRecord = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    record.title = title;
    record.saved_at = now_millis()?;
    let updated_text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    fs::write(path, updated_text).map_err(|e| e.to_string())?;
    Ok(AgentSessionSummary {
        id: record.id,
        title: record.title,
        saved_at: record.saved_at,
    })
}
#[tauri::command]
pub fn delete_agent_session(app: AppHandle, id: String) -> Result<(), String> {
    let path = agent_session_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn start_chat_completion_stream(
    app: AppHandle,
    mut request: ChatStreamRequest,
    state: tauri::State<'_, ActiveStreams>,
) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err(String::from("API Key 不能为空"));
    }
    if request.model.trim().is_empty() {
        return Err(String::from("模型名称不能为空"));
    }
    if request.base_url.trim().is_empty() {
        return Err(String::from("接口地址不能为空"));
    }
    if request.messages.is_empty() {
        return Err(String::from("消息不能为空"));
    }

    let reference_context = build_reference_context(&request);
    if !reference_context.is_empty() {
        if let Some(last_msg) = request.messages.last_mut() {
            last_msg.content.push_str(&reference_context);
        }
    }

    let run_id = Uuid::new_v4().to_string();
    let spawned_run_id = run_id.clone();
    let state_app = app.clone();

    let handle = tauri::async_runtime::spawn(async move {
        emit_chat_event(
            &app,
            &spawned_run_id,
            "start",
            None,
            Some("开始生成回复".to_string()),
            &AgentRunOptions::parent(),
        );

        let mut options = AgentRunOptions::parent();
        options.allowed_tools = request.allowed_tools.clone();

        let result = match request.model_interface.as_str() {
            "Anthropic-compatible" => {
                run_anthropic_agent_loop(&app, &spawned_run_id, &request, options).await
            }
            _ => run_openai_agent_loop(&app, &spawned_run_id, &request, options).await,
        };

        match result {
            Ok(_) => emit_chat_event(
                &app,
                &spawned_run_id,
                "done",
                None,
                None,
                &AgentRunOptions::parent(),
            ),
            Err(error) => emit_chat_event(
                &app,
                &spawned_run_id,
                "error",
                None,
                Some(error),
                &AgentRunOptions::parent(),
            ),
        }

        if let Some(active_streams) = state_app.try_state::<ActiveStreams>() {
            let mut streams = active_streams.0.lock().unwrap();
            streams.remove(&spawned_run_id);
        }
    });

    state.0.lock().unwrap().insert(run_id.clone(), handle);

    Ok(run_id)
}
#[tauri::command]
pub fn stop_chat_stream(
    run_id: String,
    state: tauri::State<'_, ActiveStreams>,
) -> Result<(), String> {
    if let Some(handle) = state.0.lock().unwrap().remove(&run_id) {
        handle.abort();
    }
    Ok(())
}

fn clean_json_response(mut text: String) -> String {
    text = text.trim().to_string();
    if text.starts_with("```json") {
        text = text.strip_prefix("```json").unwrap_or(&text).to_string();
    } else if text.starts_with("```") {
        text = text.strip_prefix("```").unwrap_or(&text).to_string();
    }
    if text.ends_with("```") {
        text = text.strip_suffix("```").unwrap_or(&text).to_string();
    }
    text.trim().to_string()
}

#[tauri::command]
pub async fn analyze_character_memory(request: AnalyzeMemoryRequest) -> Result<String, String> {
    let client = reqwest::Client::new();
    let system_prompt = "你是一个专门负责伴侣角色记忆管理的AI。你需要基于本次对话记录，以及原有的关系记忆、关键事件，来分析两者的改变，并输出本次会话的建议标题。请务必严格按照JSON格式返回。";
    let user_prompt = format!(
        "根据以下对话记录，分析并生成新的关系记忆、关键事件和建议的会话标题。\n\n\
        ### 1. 本次聊天历史记录\n{}\n\n\
        ### 2. 角色目前的关系记忆\n{}\n\n\
        ### 3. 角色目前的关键事件记录\n{}\n\n\
        请结合上述对话，分析：\n\
        1. 关系记忆修改点：经过本次对话后，他们的关系应当怎样改变或加深？（如果是首次对话，基于对话分析并确立双方当前关系）。\n\
        2. 关键事件修改点：本次对话是否发生了影响深远、具有里程碑或纪念性意义的共同经历？如果有，追加到已有的关键事件中；如果没有，保持原样。\n\
        3. 会话标题：为本次会话起一个不超过15字、体现对话主题的合适标题。\n\n\
        请以纯 JSON 格式输出，不要包含 markdown 格式标记（如 ```json）或额外的解释字眼。JSON 结构必须严格满足以下字段：\n\
        {{\n  \
          \"relationMemory\": \"更新后的完整关系记忆内容\",\n  \
          \"keyEvents\": \"更新后的完整关键事件内容\",\n  \
          \"sessionTitle\": \"本次会话的建议标题（不超过15个字）\",\n  \
          \"relationChanges\": \"关于关系记忆的改变/修改点说明，如果没变请写'无修改'\",\n  \
          \"eventChanges\": \"关于关键事件的改变/修改点说明，如果没变请写'无修改'\"\n\
        }}",
        request.chat_history,
        request.current_relation,
        request.current_events
    );

    let max_tokens = request.max_output_tokens.unwrap_or(2048);

    let raw_content = match request.model_interface.as_str() {
        "Anthropic-compatible" => {
            let endpoint = build_anthropic_endpoint(&request.base_url);
            let body = json!({
                "model": request.model,
                "messages": [{"role": "user", "content": user_prompt}],
                "system": system_prompt,
                "stream": false,
                "temperature": request.temperature.unwrap_or(0.7),
                "max_tokens": max_tokens,
            });

            let response = client
                .post(&endpoint)
                .header("x-api-key", &request.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                return Err(format!("Anthropic 接口请求失败：{} {}", status, body_text));
            }

            let json: Value = response.json().await.map_err(|e| e.to_string())?;
            json.get("content")
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|item| item.get("type") == Some(&json!("text")))
                })
                .and_then(|text_block| text_block.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        }
        _ => {
            let endpoint = build_openai_endpoint(&request.base_url);
            let messages = vec![
                json!({"role": "system", "content": system_prompt}),
                json!({"role": "user", "content": user_prompt}),
            ];
            let body = json!({
                "model": request.model,
                "messages": messages,
                "stream": false,
                "temperature": request.temperature.unwrap_or(0.7),
                "max_tokens": max_tokens,
            });

            let response = client
                .post(&endpoint)
                .bearer_auth(&request.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                return Err(format!("OpenAI 兼容接口请求失败：{} {}", status, body_text));
            }

            let json: Value = response.json().await.map_err(|e| e.to_string())?;
            json.get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|msg| msg.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        }
    };

    Ok(clean_json_response(raw_content))
}
