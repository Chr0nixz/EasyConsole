# API Documentation

This document was reconstructed from the frontend bundle at:

```text
http://116.172.93.164:28080/static/js/app.f36c1631.js
```

The API list is based on frontend usage. Request and response fields are inferred and should be verified by login traffic capture or backend source code.

## Base Information

```text
Base URL: http://116.172.93.164:28080/api
Auth: Authorization request header
Format: JSON
```

Frontend axios configuration:

```js
baseURL: "/api"
timeout: 20000
headers.common["Authorization"] = token
```

Likely success response:

```json
{
  "code": 0,
  "data": {},
  "msg": "success"
}
```

Known error handling:

```text
code != 0 is treated as a business error
HTTP 401 + code 10000 means login expired or token error
code 10040 means insufficient permission
```

## Authentication And User

| Method | Path | Description |
|---|---|---|
| `GET` | `/token` | Get token-related initialization data, possibly CSRF token or public key |
| `POST` | `/user/token` | Login and get user token |
| `GET` | `/user/userinfo` | Get current user information |
| `GET` | `/user/group/members` | Get user group members |
| `PUT` | `/user/user/{id}` | Update user information |
| `POST` | `/user/user/change_password` | Change password |

Example:

```http
POST /api/user/token
Content-Type: application/json
```

```json
{
  "username": "string",
  "password": "sha256(password)"
}
```

The original frontend trims `username` and sends the SHA-256 hex digest of the password, not the plaintext password:

```js
{
  username: username.trim(),
  password: sha256(password)
}
```

Authenticated requests:

```http
Authorization: <token>
```

## Instance And Task

| Method | Path | Description |
|---|---|---|
| `GET` | `/instance/console` | Console overview |
| `GET` | `/instance/task` | Query task or instance list |
| `POST` | `/instance/task` | Create task or instance |
| `DELETE` | `/instance/task` | Batch delete tasks |
| `PUT` | `/instance/task/{id}` | Update or operate a specific task |
| `DELETE` | `/instance/task/{id}` | Delete a specific task |
| `GET` | `/instance/checkTaskName?name={name}` | Check whether task name is available |
| `GET` | `/instance/task_log?task_id={id}` | Get task logs |
| `GET` | `/instance/monitor_index` | Get instance monitoring metrics |
| `GET` | `/instance/statics` | Get instance statistics |
| `GET` | `/instance/statics_cost` | Get cost statistics |
| `GET` | `/instance/statics_cost/month` | Get monthly cost statistics |
| `GET` | `/instance/task/download` | Download task-related file |

List example:

```http
GET /api/instance/task?page=1&page_size=10
Authorization: <token>
```

Create example:

```http
POST /api/instance/task
Content-Type: application/json
Authorization: <token>
```

```json
{
  "name": "string",
  "image_id": "string",
  "resource": {},
  "storage_path": "string",
  "mount_path": "string"
}
```

## Image

| Method | Path | Description |
|---|---|---|
| `GET` | `/image/image` | Query image list |
| `POST` | `/image/image` | Add image |
| `DELETE` | `/image/image` | Batch delete images |
| `GET` | `/image/image/{id}` | Query image details |
| `PUT` | `/image/image/{id}` | Update image |
| `DELETE` | `/image/image/{id}` | Delete image |
| `GET` | `/image/image_system` | Query system images |
| `POST` | `/image/image_commit` | Commit or save image |
| `GET` | `/image/image/download/{id}` | Download image file |
| `POST` | `/image/default/{id}` | Set default image |

Download example:

```http
GET /api/image/image/download/{id}
Authorization: <token>
```

Response type:

```text
blob
```

## Storage

| Method | Path | Description |
|---|---|---|
| `GET` | `/storage/ls` | Query directory or file list |
| `POST` | `/storage/ls` | Create directory or submit file operation |
| `DELETE` | `/storage/ls` | Delete file or directory |
| `GET` | `/storage/info` | Get storage information |
| `POST` | `/storage/info` | Update storage information |
| `GET` | `/storage/file_transmit` | Download file or generate download link |
| `POST` | `/storage/chunked_upload` | Chunked upload |
| `POST` | `/storage/chunked_upload_complete` | Complete chunked upload |

Chunked upload:

```http
POST /api/storage/chunked_upload
Authorization: <token>
Content-Range: bytes {start}-{end}/{total}
```

Request body:

```text
FormData
```

Complete upload:

```http
POST /api/storage/chunked_upload_complete
Content-Type: application/x-www-form-urlencoded
Authorization: <token>
```

If `/storage/file_transmit` does not receive `generate_url`, the frontend treats the response as a blob download.

```http
GET /api/storage/file_transmit
Authorization: <token>
```

## Resource And Price

| Method | Path | Description |
|---|---|---|
| `GET` | `/back_admin/price` | Get resource price configuration |
| `GET` | `/back_admin/resource` | Get resource specification configuration |

## WebSocket

The frontend also exposes a WebSSH endpoint:

```text
/ws/webssh?task_id={id}
```

Likely full address:

```text
ws://116.172.93.164:28080/ws/webssh?task_id={id}
```

This endpoint is used for a task terminal or SSH console. It is not an axios request and does not use the `/api` base URL.
