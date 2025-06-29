> [!Warning]
> 请注意，本项目由 AI 生成，本人不保证代码可用性
>
> 中转功能可能违反 ToS，导致账号被封禁

## 概述

本项目是一个基于 Cloudflare Workers 的 OneDrive **文件上传与分发服务**（并非**公共目录列表**），支持 OAuth 授权、文件上传、中转访问、Markdown 渲染等功能。

## 功能特性

- ✅ 支持 Microsoft OAuth2 授权流程
- ✅ 支持表单上传与分块上传
- ✅ 支持中转访问与 Markdown 渲染
- ✅ 支持上传令牌校验与 Referrer 防盗链
- ✅ 支持路径白名单与缓存机制
- ✅ 支持定时任务自动刷新令牌

## 部署说明

1. 创建 Cloudflare Worker 项目
2. 配置环境变量
3. 部署[代码](./worker.js)至 Cloudflare Workers
4. 访问 `/application-retain/api/oauth` 进行授权

## 环境变量说明

| 变量名                | 说明                             | 示例                              |
| --------------------- | -------------------------------- | --------------------------------- |
| CLIENT_ID             | 应用的 Microsoft Client ID       | `abc123`                          |
| CLIENT_SECRET         | 应用的 Microsoft Secret          | `xyz456`                          |
| ADMIN_EMAILS          | 管理员邮箱白名单（逗号分隔）     | `admin@example.com`               |
| UPLOAD_TOKEN          | 上传令牌                         | `mysecrettoken`                   |
| SHAREPOINT_SITE_ID    | SharePoint 站点 ID（可选）       | `site-id`                         |
| SHAREPOINT_DRIVE_ID   | SharePoint Drive ID（可选）      | `drive-id`                        |
| ALLOWED_REFERRERS     | 允许的 Referrer 域名（逗号分隔） | `example.com,www.example.com`     |
| REFERRER_POLICY       | Referrer 策略                    | `strict-origin-when-cross-origin` |
| EMPTY_REFERRER_POLICY | 空 Referrer 策略                 | `allow` 或 `block`                |
| CACHE_TTL             | 缓存时间（秒）                   | `86400`                           |

非重要内容可以选择文本，重要内容请选择机密

![Image](https://github.com/user-attachments/assets/1948b268-4735-4e07-8878-164218d760e6)

为了保持令牌，请添加定时任务，表达式为 `0 12 * * *`

![image](https://github.com/user-attachments/assets/b9c279ff-9bed-4b79-9234-d573b88ce655)

本项目还需 KV 绑定，名称请固定填写 `OD_CACHE`

![image](https://github.com/user-attachments/assets/cd0ec456-2029-4600-8f6c-0baabed8cc02)


## API 接口和 Demo

[API 接口说明](./API.md) & [Demo 页面](./example.html)

有部署上的疑问，可以通过代码解决（比如应用 API 权限等）

Demo 页面提供了上传、分块上传的示例，由 AI 生成
