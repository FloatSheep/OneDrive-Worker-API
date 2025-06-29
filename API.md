所有接口前缀为 `/application-retain/api/`

---

## 🔐 授权相关

### `GET /oauth`
跳转到 Microsoft 登录授权页面。

### `GET /redirect`
授权成功后的回调处理，完成令牌交换并验证管理员邮箱。

---

## 📤 文件上传

### `POST /upload?upload_token=xxx`
表单上传图片文件。

- 请求方式：`multipart/form-data`
- 参数说明：
  - `file`：上传的图片文件（字段名为 `file`）
  - `path`：可选，上传路径（默认 `/uploads`）
- 支持类型：JPEG, PNG, GIF, WEBP
- 限制大小：100MB（可通过变量修改，不能超过 Cloudflare 最大限制）

### `POST /upload/create-session?upload_token=xxx`
创建分块上传会话。

- 请求方式：`application/json`
- 参数说明：
  - `fileName`：文件名
  - `fileSize`：文件大小（字节）
  - `uploadPath`：上传路径（可选）

### `PUT /upload/chunk/:sessionId`
上传文件分块。

- 请求头：
  - `Content-Range: bytes start-end/total`
- 请求体：文件分块的二进制数据
- 返回：
  - `202`：分块上传成功，返回下一期望分块范围
  - `200/201`：文件上传完成，返回文件信息及 CDN 地址

---

## 📊 状态检查

### `GET /status`
返回服务状态、令牌状态、缓存状态等信息。

- 返回字段：
  - `auth_status`：是否已授权
  - `token_expiry`：令牌过期时间
  - `uptime`：服务运行时间
  - `cache_status`：缓存状态
  - `version`：服务版本号

---

## 📁 文件访问

### `GET /...`
访问上传的文件。

- 可选参数：
  - `?proxy`：代理模式，直接返回文件内容
  - `?render`：Markdown 渲染模式，仅适用于 `.md` 文件

- 返回：
  - `302`：重定向到真实下载地址
  - `200`：代理模式下返回文件内容
  - `HTML`：Markdown 渲染页面

---

## 📦 响应格式

所有接口返回 JSON 格式，包含字段：

```json
{
  "code": 200,
  "message": "操作成功",
  "data": { ... },
  "error": "错误信息（可选）",
  "action": { "retry": "建议操作" }
}

```
