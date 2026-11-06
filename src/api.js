export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({ error: '服务响应异常，请稍后重试。' }));
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      window.dispatchEvent(new Event('session-expired'));
    }
    const error = new Error(data.error || '操作失败，请稍后重试。');
    error.details = data.details || [];
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function uploadFile(path, file, extraHeaders = {}) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-File-Type': file.type || 'application/octet-stream',
      ...extraHeaders,
    },
    body: file,
  });
  const data = await response.json().catch(() => ({ error: '服务响应异常，请稍后重试。' }));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
    const error = new Error(data.error || '文件上传失败，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function saveJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
