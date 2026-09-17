//! Explicit browser link downloads.
//!
//! A same-origin link is fetched only after an explicit user action. Desktop
//! builds fetch through the native client to avoid webview CORS, then choose
//! the destination through the native save dialog. This module is the final
//! trust boundary: it validates origins and destinations, bounds bytes and
//! never creates directories or executes content.

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Duration;

const MAX_DOWNLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_URL_CHARS: usize = 4096;

/// A bounded response fetched by an explicit same-origin browser action.
/// The renderer chooses the destination after this payload is returned.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub data: String,
    pub content_type: String,
}

fn parse_http_url(raw: &str) -> Result<reqwest::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("browser download URL must not be empty".to_string());
    }
    if trimmed.chars().count() > MAX_URL_CHARS {
        return Err(format!(
            "browser download URL is limited to {MAX_URL_CHARS} characters"
        ));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "browser download URL is not valid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("browser downloads only support http and https URLs".to_string());
    }
    if url.host_str().is_none() {
        return Err("browser download URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("browser download URLs with embedded credentials are not allowed".to_string());
    }
    Ok(url)
}

fn same_origin(page: &reqwest::Url, target: &reqwest::Url) -> bool {
    page.scheme() == target.scheme()
        && page.host_str() == target.host_str()
        && page.port_or_known_default() == target.port_or_known_default()
}

/// Fetch one explicitly selected same-origin link in the native runtime.
/// Cookies, credentials and redirects are intentionally disabled; the stream
/// is bounded before bytes are returned to the renderer.
pub async fn fetch_same_origin(page_url: &str, target_url: &str) -> Result<FetchResult, String> {
    let page = parse_http_url(page_url)?;
    let target = parse_http_url(target_url)?;
    if !same_origin(&page, &target) {
        return Err("for safety, downloads are limited to the current page origin".to_string());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not prepare browser download: {e}"))?;
    let response = client
        .get(target)
        .send()
        .await
        .map_err(|e| format!("browser download request failed: {e}"))?;
    if response.status().is_redirection() {
        return Err("browser download redirects are not allowed".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "browser download server returned {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES as u64)
    {
        return Err("the selected file exceeds the 10 MB download limit".to_string());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(200).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("browser download stream failed: {e}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_DOWNLOAD_BYTES {
            return Err("the selected file exceeds the 10 MB download limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("the selected file is empty".to_string());
    }
    Ok(FetchResult {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        content_type,
    })
}

pub fn write_base64(path: &Path, data: &str) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("browser download destination must not be empty".to_string());
    }
    if !path.is_absolute() {
        return Err("browser download destination must be an absolute path".to_string());
    }
    if path.exists() && path.is_dir() {
        return Err("browser download destination is a directory".to_string());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "browser download destination has no parent folder".to_string())?;
    if !parent.is_dir() {
        return Err("browser download destination folder does not exist".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "browser download payload is not valid base64".to_string())?;
    if bytes.is_empty() {
        return Err("browser download payload is empty".to_string());
    }
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "browser download is limited to {} MiB",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    fs::write(path, bytes).map_err(|error| format!("could not write browser download: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve_once(response: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    #[test]
    fn writes_bounded_base64_to_an_absolute_destination() {
        let root =
            std::env::temp_dir().join(format!("muse-browser-download-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("report.txt");
        write_base64(&target, "aGVsbG8=").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hello");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_relative_missing_parent_and_oversized_payloads() {
        assert!(write_base64(Path::new("report.txt"), "aA==").is_err());
        let missing_parent = std::env::temp_dir()
            .join(format!(
                "muse-browser-download-missing-{}",
                std::process::id()
            ))
            .join("report.txt");
        assert!(write_base64(&missing_parent, "aA==").is_err());
        let root = std::env::temp_dir().join(format!(
            "muse-browser-download-large-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let large =
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_DOWNLOAD_BYTES + 1]);
        assert!(write_base64(&root.join("large.bin"), &large).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_origin_validation_rejects_cross_origin_and_credentials() {
        let page = parse_http_url("https://example.com/docs").unwrap();
        let same = parse_http_url("https://example.com/files/a.csv").unwrap();
        let port = parse_http_url("https://example.com:444/files/a.csv").unwrap();
        let scheme = parse_http_url("http://example.com/files/a.csv").unwrap();
        let host = parse_http_url("https://cdn.example.com/files/a.csv").unwrap();
        assert!(same_origin(&page, &same));
        assert!(!same_origin(&page, &port));
        assert!(!same_origin(&page, &scheme));
        assert!(!same_origin(&page, &host));
        assert!(parse_http_url("https://user:pass@example.com/a").is_err());
    }

    #[test]
    fn native_fetch_url_validation_is_bounded_and_web_only() {
        assert!(parse_http_url("javascript:alert(1)").is_err());
        assert!(parse_http_url(&format!(
            "https://example.com/{}",
            "x".repeat(MAX_URL_CHARS)
        ))
        .is_err());
        assert!(parse_http_url("https://example.com/a").is_ok());
    }

    #[tokio::test]
    async fn native_fetch_returns_bounded_bytes_and_content_type() {
        let origin = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello",
        )
        .await;
        let result = fetch_same_origin(&format!("{origin}/page"), &format!("{origin}/file"))
            .await
            .unwrap();
        assert_eq!(result.data, "aGVsbG8=");
        assert_eq!(result.content_type, "text/plain; charset=utf-8");
    }

    #[tokio::test]
    async fn native_fetch_rejects_redirects() {
        let origin =
            serve_once("HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\n\r\n")
                .await;
        let error = fetch_same_origin(&origin, &format!("{origin}/file"))
            .await
            .unwrap_err();
        assert!(error.contains("redirect"), "{error}");
    }
}
