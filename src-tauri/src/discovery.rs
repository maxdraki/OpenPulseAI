use serde::Serialize;

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct ValidateResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub models: Vec<ModelInfo>,
}

fn err_result(msg: &str) -> ValidateResult {
    ValidateResult {
        valid: false,
        error: Some(msg.to_string()),
        models: vec![],
    }
}

#[tauri::command]
pub async fn validate_and_list_models(
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<ValidateResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    match provider.as_str() {
        "anthropic" => {
            let key = match api_key {
                Some(k) if !k.is_empty() => k,
                _ => return Ok(err_result("API key is required")),
            };
            let resp = client
                .get("https://api.anthropic.com/v1/models")
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await;

            match resp {
                Ok(r) if r.status() == 401 || r.status() == 403 => {
                    Ok(err_result("Invalid API key"))
                }
                Ok(r) if r.status().is_success() => {
                    let body: serde_json::Value = r.json().await.unwrap_or_default();
                    let mut models: Vec<ModelInfo> = body["data"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .map(|m| ModelInfo {
                            id: m["id"].as_str().unwrap_or("").to_string(),
                            name: m["display_name"]
                                .as_str()
                                .unwrap_or(m["id"].as_str().unwrap_or(""))
                                .to_string(),
                        })
                        .filter(|m| !m.id.is_empty())
                        .collect();
                    models.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(ValidateResult { valid: true, error: None, models })
                }
                Ok(r) => Ok(err_result(&format!("API error: {}", r.status()))),
                Err(e) if e.is_timeout() => Ok(err_result("Connection timed out")),
                Err(_) => Ok(err_result("Cannot connect to Anthropic")),
            }
        }
        "openai" => {
            let key = match api_key {
                Some(k) if !k.is_empty() => k,
                _ => return Ok(err_result("API key is required")),
            };
            let resp = client
                .get("https://api.openai.com/v1/models")
                .header("Authorization", format!("Bearer {}", key))
                .send()
                .await;

            match resp {
                Ok(r) if r.status() == 401 || r.status() == 403 => {
                    Ok(err_result("Invalid API key"))
                }
                Ok(r) if r.status().is_success() => {
                    let body: serde_json::Value = r.json().await.unwrap_or_default();
                    let chat_prefixes = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
                    let mut models: Vec<ModelInfo> = body["data"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .filter_map(|m| {
                            let id = m["id"].as_str()?;
                            if chat_prefixes.iter().any(|p| id.starts_with(p)) {
                                Some(ModelInfo {
                                    id: id.to_string(),
                                    name: id.to_string(),
                                })
                            } else {
                                None
                            }
                        })
                        .collect();
                    models.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(ValidateResult { valid: true, error: None, models })
                }
                Ok(r) => Ok(err_result(&format!("API error: {}", r.status()))),
                Err(e) if e.is_timeout() => Ok(err_result("Connection timed out")),
                Err(_) => Ok(err_result("Cannot connect to OpenAI")),
            }
        }
        "gemini" => {
            let key = match api_key {
                Some(k) if !k.is_empty() => k,
                _ => return Ok(err_result("API key is required")),
            };
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={}",
                key
            );
            let resp = client.get(&url).send().await;

            match resp {
                Ok(r) if r.status() == 400 || r.status() == 401 || r.status() == 403 => {
                    Ok(err_result("Invalid API key"))
                }
                Ok(r) if r.status().is_success() => {
                    let body: serde_json::Value = r.json().await.unwrap_or_default();
                    let mut models: Vec<ModelInfo> = body["models"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .filter(|m| {
                            m["supportedGenerationMethods"]
                                .as_array()
                                .map(|methods| {
                                    methods.iter().any(|method| {
                                        method.as_str() == Some("generateContent")
                                    })
                                })
                                .unwrap_or(false)
                        })
                        .map(|m| {
                            let raw_name = m["name"].as_str().unwrap_or("");
                            let id = raw_name.strip_prefix("models/").unwrap_or(raw_name);
                            ModelInfo {
                                id: id.to_string(),
                                name: m["displayName"]
                                    .as_str()
                                    .unwrap_or(id)
                                    .to_string(),
                            }
                        })
                        .filter(|m| !m.id.is_empty())
                        .collect();
                    models.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(ValidateResult { valid: true, error: None, models })
                }
                Ok(r) => Ok(err_result(&format!("API error: {}", r.status()))),
                Err(e) if e.is_timeout() => Ok(err_result("Connection timed out")),
                Err(_) => Ok(err_result("Cannot connect to Gemini")),
            }
        }
        "ollama" => {
            let url = base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            let resp = client
                .get(format!("{}/api/tags", url))
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => {
                    let body: serde_json::Value = r.json().await.unwrap_or_default();
                    let mut models: Vec<ModelInfo> = body["models"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .map(|m| {
                            let name = m["name"].as_str().unwrap_or("").to_string();
                            ModelInfo {
                                id: name.clone(),
                                name,
                            }
                        })
                        .filter(|m| !m.id.is_empty())
                        .collect();
                    models.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(ValidateResult { valid: true, error: None, models })
                }
                Ok(_) => Ok(err_result(&format!("Cannot connect to Ollama at {}", url))),
                Err(e) if e.is_timeout() => Ok(err_result("Connection timed out")),
                Err(_) => Ok(err_result(&format!("Cannot connect to Ollama at {}", url))),
            }
        }
        _ => Ok(err_result(&format!("Unknown provider: {}", provider))),
    }
}
