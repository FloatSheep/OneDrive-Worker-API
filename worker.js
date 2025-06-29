export default {
  async fetch(request, env) {
    try {
      // 令牌自动刷新
      await OneDriveHandler.monitorTokenRefresh(env, {});

      return OneDriveHandler.handleRequest(request, env);
    } catch (error) {
      return new Response(
        JSON.stringify({
          code: 500,
          message: "Unhandled exception in worker",
          error: error.message,
          stack: OneDriveHandler.initConfig().development ? error.stack : null,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },

  async scheduled(_event, env) {
    // 定时令牌刷新
    try {
      const refreshed = await OneDriveHandler.monitorTokenRefresh(env, {});
      return new Response(refreshed ? "Token refreshed" : "No refresh needed");
    } catch (error) {
      return new Response(`Scheduled task failed: ${error.message}`, {
        status: 500,
      });
    }
  },
};

class OneDriveHandler {
  // 获取配置配置
  static initConfig(env) {
    return {
      adminEmails: env.ADMIN_EMAILS
        ? env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase())
        : [],
      clientId: env.CLIENT_ID,
      clientSecret: env.CLIENT_SECRET,
      uploadToken: env.UPLOAD_TOKEN,
      sharepoint: {
        siteId: env.SHAREPOINT_SITE_ID,
        driveId: env.SHAREPOINT_DRIVE_ID,
      },
      allowedPaths: ["/OneDriveImageHosting/*"],
      upload: {
        maxFileSize: 100 * 1024 * 1024,
        allowedTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
      },
      cacheTTL: env.CACHE_TTL ? parseInt(env.CACHE_TTL) : 86400, // 默认24小时
      security: {
        referrerPolicy:
          env.REFERRER_POLICY || "strict-origin-when-cross-origin",
        emptyReferrerPolicy: env.EMPTY_REFERRER_POLICY || "allow",
        allowedReferrers: env.ALLOWED_REFERRERS
          ? env.ALLOWED_REFERRERS.split(",").map((r) => r.trim())
          : [],
      },
      development: env.DEVELOPMENT || false,
    };
  }

  // 分发请求
  static async handleRequest(request, env) {
    // 初始化配置
    const CONFIG = this.initConfig(env);

    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/application-retain/api/")) {
      // 预检
      if (request.method === "OPTIONS") {
        return this.addCorsHeaders(this.handleCorsPreflight(request));
      }

      // 认证路由
      if (
        path === "/application-retain/api/oauth" ||
        path === "/application-retain/api/redirect"
      ) {
        return this.addCorsHeaders(
          await this.handleAuthRoutes(request, env, CONFIG)
        );
      }

      // 文件上传处理
      if (path === "/application-retain/api/upload") {
        return this.addCorsHeaders(
          await this.handleFileUpload(request, env, CONFIG)
        );
      }

      // 创建分块上传会话
      if (path === "/application-retain/api/upload/create-session") {
        return this.addCorsHeaders(
          await this.handleCreateUploadSession(request, env, CONFIG)
        );
      }

      // 分块上传处理
      if (path.startsWith("/application-retain/api/upload/chunk")) {
        return this.addCorsHeaders(await this.handleUploadChunk(request, env));
      }

      // 状态管理
      if (path === "/application-retain/api/status") {
        return this.addCorsHeaders(await this.handleStatusCheck(env));
      }

      return this.addCorsHeaders(
        this.jsonResponse(
          {
            code: 404,
            message: "API endpoint not found",
          },
          404
        )
      );
    }

    // 文件请求处理
    return this.handleFileRequest(request, env, CONFIG);
  }

  // 预检响应
  static handleCorsPreflight() {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, Content-Range",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400", // 24小时缓存
        Vary: "Origin",
      },
    });
  }

  // 跨域头
  static addCorsHeaders(response) {
    // 克隆响应以便添加头部
    const newResponse = new Response(response.body, response);

    // 添加 CORS 头部
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    newResponse.headers.set("Access-Control-Allow-Credentials", "true");

    return newResponse;
  }

  // OAuth 处理
  static async handleAuthRoutes(request, env, CONFIG) {
    const url = new URL(request.url);
    const path = url.pathname;
    const redirectUri = `${url.origin}/application-retain/api/redirect`;

    if (path === "/application-retain/api/oauth") {
      const authUrl = new URL(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
      );

      // 添加读写权限以支持上传
      authUrl.searchParams.set(
        "scope",
        "Files.ReadWrite.All Sites.ReadWrite.All offline_access User.Read"
      );
      authUrl.searchParams.set("client_id", CONFIG.clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set(
        "state",
        JSON.stringify({
          redirect: url.searchParams.get("redirect") || "/",
        })
      );
      authUrl.searchParams.set("prompt", "select_account");

      return Response.redirect(authUrl.toString(), 302);
    }

    // 重定向路由
    if (path === "/application-retain/api/redirect") {
      return this.handleOAuthRedirect(request, env, redirectUri, CONFIG);
    }
  }

  // OAuth 重定向
  static async handleOAuthRedirect(request, env, redirectUri, CONFIG) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");

    if (!code) {
      return this.jsonResponse(
        {
          code: 400,
          message: "Authorization failed: Missing authorization code",
          action: {
            retry_url: "/application-retain/api/oauth",
          },
        },
        400
      );
    }

    try {
      const tokenResponse = await fetch(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: CONFIG.clientId,
            client_secret: CONFIG.clientSecret,
            code,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        }
      );

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json();
        return this.jsonResponse(
          {
            code: 401,
            message: "Token exchange failed",
            error: {
              code: errorData.error,
              description: errorData.error_description,
            },
            action: {
              retry_url: "/application-retain/api/oauth",
            },
          },
          401
        );
      }

      const tokenData = await tokenResponse.json();

      const userInfo = await this.getUserEmail(tokenData.access_token);

      console.log(userInfo);

      if (!userInfo || !userInfo.mail) {
        throw new Error("Information is broken.");
      }

      const userEmail = userInfo.mail.toLowerCase();
      const isValidAdmin =
        CONFIG.adminEmails.length === 0 ||
        CONFIG.adminEmails.includes(userEmail);

      if (!isValidAdmin) {
        return this.jsonResponse(
          {
            code: 401,
            message: "Email isn't allowed",
            error: {
              code: 401,
              description:
                "Maybe you authorized your account wrongly, please contact admin.",
            },
            action: {
              retry_url: "/application-retain/api/oauth",
            },
          },
          401
        );
      }

      await this.storeTokens(env, tokenData);

      return Response.redirect(
        redirectUri.split("/application-retain/")[0],
        301
      );
    } catch (e) {
      return this.jsonResponse(
        {
          code: 500,
          message: "Server error during authorization",
          error: e.message,
          action: {
            retry_url: "/application-retain/api/oauth",
          },
        },
        500
      );
    }
  }

  // 获取用户邮箱
  static async getUserEmail(accessToken) {
    try {
      const response = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Failed to get user info: ${errorData.error?.message}, statusCode: ${response.status}`
        );
      }

      return await response.json();
    } catch (error) {
      console.error("User info fetch error:", error);
      return null;
    }
  }

  // 状态检查
  static async handleStatusCheck(env) {
    try {
      const tokenMeta = await env.OD_CACHE.get("token_meta");
      const accessToken = await env.OD_CACHE.get("access_token");

      return this.jsonResponse({
        code: 200,
        message: "Service is operational",
        data: {
          auth_status: accessToken ? "authenticated" : "unauthenticated",
          token_expiry: tokenMeta ? JSON.parse(tokenMeta).expires_at : null,
          uptime: Math.floor(performance.now() / 1000) + " seconds",
          cache_status: "active",
          version: "1.2.0",
        },
      });
    } catch (error) {
      return this.jsonResponse(
        {
          code: 500,
          message: "Status check failed",
          error: error.message,
        },
        500
      );
    }
  }

  // 获取上传令牌
  static async handleCreateUploadSession(request, env, CONFIG) {
    try {
      // 验证上传令牌
      const url = new URL(request.url);
      const uploadToken = url.searchParams.get("upload_token");

      if (uploadToken !== CONFIG.uploadToken) {
        return this.jsonResponse(
          {
            code: 401,
            message: "Invalid upload token",
            action: {
              retry: "Provide a valid upload_token parameter",
            },
          },
          401
        );
      }

      if (request.method !== "POST") {
        return this.jsonResponse(
          {
            code: 405,
            message: "Method not allowed",
          },
          405
        );
      }

      const accessToken = await this.getAccessToken(env, CONFIG);
      const { fileName, fileSize, uploadPath } = await request.json();

      if (!fileName || !fileSize) {
        return this.jsonResponse(
          {
            code: 400,
            message: "Missing required parameters",
            action: {
              retry: "Provide fileName and fileSize in JSON body",
            },
          },
          400
        );
      }

      // 验证文件大小
      if (fileSize > CONFIG.upload.maxFileSize) {
        return this.jsonResponse(
          {
            code: 400,
            message: "File too large",
            file_size: fileSize,
            max_size: CONFIG.upload.maxFileSize,
            action: {
              retry: "Upload a smaller image",
            },
          },
          400
        );
      }

      const fullPath = `${uploadPath || "/uploads"}/${fileName}`;
      const cleanPath = fullPath.startsWith("/")
        ? fullPath.substring(1)
        : fullPath;

      // 确定API端点
      let apiEndpoint;
      if (CONFIG.sharepoint.siteId && CONFIG.sharepoint.driveId) {
        apiEndpoint = `https://graph.microsoft.com/v1.0/sites/${CONFIG.sharepoint.siteId}/drives/${CONFIG.sharepoint.driveId}/root:/${cleanPath}:/createUploadSession`;
      } else {
        apiEndpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${cleanPath}:/createUploadSession`;
      }

      // 创建上传会话
      const sessionResponse = await fetch(apiEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          item: {
            "@microsoft.graph.conflictBehavior": "rename",
          },
        }),
      });

      if (!sessionResponse.ok) {
        const errorData = await sessionResponse.json();
        throw new Error(
          `Upload session creation failed: ${errorData.error?.message}`
        );
      }

      const sessionData = await sessionResponse.json();

      const sessionId = crypto.randomUUID();
      const sessionKey = `upload_session_${sessionId}`;
      await env.OD_CACHE.put(
        sessionKey,
        JSON.stringify({
          uploadUrl: sessionData.uploadUrl,
          expiration: sessionData.expirationDateTime,
          filePath: fullPath,
          realLink: url.searchParams.has("realLink") ? true : false,
        }),
        { expirationTtl: 3600 }
      ); // 1小时有效期

      return this.jsonResponse({
        code: 200,
        message: "Upload session created",
        data: {
          session_id: sessionId, // 返回会话ID给客户端
          expiration_date: sessionData.expirationDateTime,
          next_expected_ranges: sessionData.nextExpectedRanges,
        },
      });
    } catch (error) {
      return this.jsonResponse(
        {
          code: 500,
          message: "Upload session creation failed",
          error: error.message,
          action: {
            retry: "Try again later",
          },
        },
        500
      );
    }
  }

  // 分块上传处理
  static async handleUploadChunk(request, env) {
    try {
      const url = new URL(request.url);
      const sessionId = url.pathname.split("/").pop();

      // 验证会话ID格式
      if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
        return this.jsonResponse(
          {
            code: 400,
            message: "Invalid session ID format",
          },
          400
        );
      }

      // 获取会话信息
      const sessionKey = `upload_session_${sessionId}`;
      const sessionData = await env.OD_CACHE.get(sessionKey, { type: "json" });

      if (!sessionData) {
        return this.jsonResponse(
          {
            code: 404,
            message: "Upload session not found or expired",
          },
          404
        );
      }

      // 验证分块范围
      const contentRange = request.headers.get("Content-Range");
      if (!contentRange) {
        return this.jsonResponse(
          {
            code: 400,
            message: "Missing Content-Range header",
          },
          400
        );
      }

      // 上传分块数据
      const chunkData = await request.arrayBuffer();
      const uploadResponse = await fetch(sessionData.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": chunkData.byteLength.toString(),
          "Content-Range": contentRange,
        },
        body: chunkData,
      });

      // 处理上传响应
      if (uploadResponse.status === 202) {
        const nextRange = uploadResponse.headers.get("NextExpectedRanges");
        return this.jsonResponse({
          code: 202,
          message: "Chunk uploaded",
          next_expected_ranges: nextRange ? [nextRange] : [],
        });
      }

      if (uploadResponse.status === 200 || uploadResponse.status === 201) {
        const fileInfo = await uploadResponse.json();

        // 获取文件路径
        const filePath = sessionData.filePath.split("/")[0];

        // 构建 CDN URL（代理地址）
        const cdnUrl = new URL(request.url);
        cdnUrl.pathname = `${filePath}/${fileInfo["name"]}`; // 使用原始文件路径
        cdnUrl.search = "";

        const responseData = {
          code: 200,
          message: "File upload completed",
          data: {
            file_name: fileInfo["name"],
            file_size: fileInfo.size || 0,
            cdn_url: cdnUrl.toString(),
            cdn_proxy_url: `${cdnUrl.toString()}?proxy`,
            file_path: filePath,
            upload_time: new Date().toISOString(),
          },
        };

        // 如果请求包含 realLink 参数，添加真实地址
        if (sessionData.realLink) {
          responseData.data.real_download_url =
            fileInfo["@microsoft.graph.downloadUrl"];
          responseData.data.real_web_url = fileInfo.webUrl;
        }

        // 清理会话
        await env.OD_CACHE.delete(sessionKey);

        return this.jsonResponse(responseData);
      }

      // 处理错误
      const errorData = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status} - ${errorData}`);
    } catch (error) {
      console.error(`[UPLOAD CHUNK ERROR] ${this.initConfig().development ? error.stack : null}`);
      return this.jsonResponse(
        {
          code: 500,
          message: "Chunk upload failed",
          error: error.message,
          action: { retry: true },
        },
        500
      );
    }
  }

  // 文件上传处理
  static async handleFileUpload(request, env, CONFIG) {
    try {
      // 验证上传令牌
      const url = new URL(request.url);
      const uploadToken = url.searchParams.get("upload_token");

      if (uploadToken !== CONFIG.uploadToken) {
        return this.jsonResponse(
          {
            code: 401,
            message: "Invalid upload token",
            action: {
              retry: "Provide a valid upload_token parameter",
            },
          },
          401
        );
      }

      // 只允许POST请求
      if (request.method !== "POST") {
        return this.jsonResponse(
          {
            code: 405,
            message: "Method not allowed. Use POST for file uploads.",
          },
          405
        );
      }

      const accessToken = await this.getAccessToken(env, CONFIG);
      const formData = await request.formData();
      const file = formData.get("file");
      const uploadPath = formData.get("path") || "/uploads";

      if (!file || !(file instanceof File)) {
        return this.jsonResponse(
          {
            code: 400,
            message: "No file provided in the request",
            action: {
              retry: "Ensure you're sending a file with the 'file' field",
            },
          },
          400
        );
      }

      // 只允许图片类型
      if (!CONFIG.upload.allowedTypes.includes(file.type)) {
        return this.jsonResponse(
          {
            code: 400,
            message: "Unsupported file type. Only images are allowed.",
            file_type: file.type,
            allowed_types: CONFIG.upload.allowedTypes,
            action: {
              retry: "Upload an image file (JPEG, PNG, GIF, WEBP)",
            },
          },
          400
        );
      }

      if (file.size > CONFIG.upload.maxFileSize) {
        return this.jsonResponse(
          {
            code: 400,
            message: "File too large",
            file_size: file.size,
            max_size: CONFIG.upload.maxFileSize,
            action: {
              retry: "Upload a smaller image",
            },
          },
          400
        );
      }

      const fullPath = `${
        uploadPath.endsWith("/") ? uploadPath : uploadPath + "/"
      }${file.name}`;

      const uploadResult = await this.uploadToOneDrive(
        accessToken,
        fullPath,
        await file.arrayBuffer(),
        CONFIG
      );

      const cdnUrl = new URL(request.url);
      cdnUrl.pathname = fullPath;
      cdnUrl.search = ""; // 清除所有查询参数

      // 构建响应数据
      const responseData = {
        code: 200,
        message: "File uploaded successfully",
        data: {
          file_name: file.name,
          file_size: file.size,
          content_type: file.type,
          cdn_url: cdnUrl.toString(), // 新增：CDN代理地址
          cdn_proxy_url: `${cdnUrl.toString()}?proxy`, // 代理模式URL
          file_path: fullPath,
          upload_time: new Date().toISOString(),
        },
      };

      // 如果请求包含 realLink 参数，添加真实地址
      if (url.searchParams.has("realLink")) {
        responseData.data.real_download_url = uploadResult.downloadUrl;
        responseData.data.real_web_url = uploadResult.webUrl;
      }

      return this.jsonResponse(responseData);
    } catch (error) {
      return this.jsonResponse(
        {
          code: 500,
          message: "File upload failed",
          error: error.message,
          action: {
            retry: "Try again later",
          },
        },
        500
      );
    }
  }

  // 文件请求处理
  static async handleFileRequest(request, env, CONFIG) {
    try {
      const url = new URL(request.url);
      const filePath = url.pathname;
      const proxyMode = url.searchParams.has("proxy");
      const renderMode = url.searchParams.has("render");

      // 根路径返回服务信息
      if (filePath === "/") {
        return this.jsonResponse({
          code: 200,
          message: "OneDrive CDN Service",
          endpoints: {
            auth: "/application-retain/api/oauth",
            upload: "/application-retain/api/upload?upload_token=YOUR_TOKEN",
            status: "/application-retain/api/status",
          },
        });
      }

      if (filePath.includes("../") || filePath.includes("..\\")) {
        return this.jsonResponse(
          {
            code: 403,
            message: "Invalid path traversal detected",
          },
          403
        );
      }

      // 防盗链
      const referrerCheck = this.checkReferrer(request, CONFIG.security);
      if (!referrerCheck.allowed) {
        return new Response("Forbidden: Invalid referrer", {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "Content-Type": "text/plain",
            "X-Referrer-Policy": CONFIG.security.referrerPolicy,
          },
        });
      }

      // 增强缓存处理
      const cacheKey = `file_req:${filePath}`;
      const cachedResponse = await env.OD_CACHE.get(cacheKey);
      if (cachedResponse) {
        return new Response(cachedResponse.body, {
          headers: cachedResponse.headers,
          status: 200,
        });
      }

      // 修复路径匹配问题
      if (!this.isPathAllowed(filePath, CONFIG.allowedPaths)) {
        return this.jsonResponse(
          {
            code: 403,
            message: "Access denied: Path not allowed",
            path: filePath,
            // 不返回完整配置，只返回简单的消息
            action: {
              retry: "Contact administrator for access",
            },
          },
          403
        );
      }

      // 获取访问令牌
      const accessToken = await this.getAccessToken(env, CONFIG);

      // 尝试获取原始文件
      try {
        // 获取文件下载URL
        const downloadUrl = await this.getFileDownloadUrl(
          accessToken,
          filePath,
          env,
          CONFIG
        );

        // 代理模式: 返回文件内容
        if (proxyMode) {
          return this.handleProxyMode(downloadUrl, filePath);
        }

        // Markdown渲染模式
        if (renderMode && url.pathname.includes(".md")) {
          return this.handleReadmeRender(downloadUrl);
        }

        // 直接模式: 302重定向
        return new Response(null, {
          status: 302,
          headers: {
            Location: downloadUrl,
            "Cache-Control": "public, max-age=300",
            "CDN-Cache": "HIT",
          },
        });
      } catch (fileError) {
        // 如果文件不存在，尝试查找 README.md
        if (fileError.message.includes("directory")) {
          const readmePath = filePath.endsWith("/")
            ? `${filePath}README.md`
            : `${filePath}/README.md`;

          try {
            const readmeUrl = await this.getFileDownloadUrl(
              accessToken,
              readmePath,
              env,
              CONFIG
            );
            return this.handleReadmeRender(readmeUrl);
          } catch (readmeError) {
            // 回退到错误信息
            return this.jsonResponse(
              {
                code: 404,
                message:
                  "Requested resource not found and no README.md available",
                path: filePath,
                error: fileError.message,
              },
              404
            );
          }
        }

        // 抛出原始错误
        throw fileError;
      }
    } catch (error) {
      // 令牌失效时引导用户重新授权
      if (
        error.message.includes("No refresh token") ||
        error.message.includes("Token refresh failed")
      ) {
        return this.jsonResponse(
          {
            code: 401,
            message: "Authentication required",
            action: {
              auth_url: "/application-retain/api/oauth",
            },
            error: error.message,
          },
          401
        );
      }

      return this.jsonResponse(
        {
          code: 500,
          message: "Server error",
          error: error.message,
          stack: this.initConfig().development ? error.stack : null,
        },
        500
      );
    }
  }

  // 代理模式
  static async handleProxyMode(downloadUrl, filePath) {
    const response = await fetch(downloadUrl, {
      cf: {
        cacheTtl: 86400, // 24小时缓存
        cacheEverything: true,
      },
    });

    // 获取文件扩展名
    const extension = filePath.split(".").pop().toLowerCase();

    // MIME类型映射
    const mimeTypes = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      bmp: "image/bmp",
      tiff: "image/tiff",
      pdf: "application/pdf",
      txt: "text/plain",
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      js: "application/javascript",
      json: "application/json",
      xml: "application/xml",
      zip: "application/zip",
      rar: "application/x-rar-compressed",
      "7z": "application/x-7z-compressed",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      mp4: "video/mp4",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
    };

    // 确定内容类型
    const contentType =
      mimeTypes[extension] ||
      response.headers.get("Content-Type") ||
      "application/octet-stream";

    // 创建可流式传输的响应
    const { readable, writable } = new TransformStream();
    response.body.pipeTo(writable);

    return new Response(readable, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Content-Disposition": `inline; filename="${filePath
          .split("/")
          .pop()}"`,
        "X-Origin-Size": response.headers.get("Content-Length") || "unknown",
      },
    });
  }

  // 文件下载
  static async getFileDownloadUrl(accessToken, filePath, env, CONFIG) {
    // 生成缓存键
    const cacheKey = `file_url:${filePath}`;

    // 尝试从缓存获取
    const cachedUrl = await env.OD_CACHE.get(cacheKey);
    if (cachedUrl) return cachedUrl;

    // 处理路径格式
    const cleanPath = filePath.startsWith("/")
      ? filePath.substring(1)
      : filePath;

    // 确定API端点
    let apiEndpoint;
    if (CONFIG.sharepoint.siteId && CONFIG.sharepoint.driveId) {
      apiEndpoint = `https://graph.microsoft.com/v1.0/sites/${CONFIG.sharepoint.siteId}/drives/${CONFIG.sharepoint.driveId}/root:/${cleanPath}`;
    } else {
      apiEndpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${cleanPath}`;
    }

    // 获取文件元数据
    const response = await fetch(apiEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) throw new Error("File not found");

      const errorData = await response.json();
      throw new Error(
        `API request failed: ${errorData.error?.message || response.statusText}`
      );
    }

    const itemData = await response.json();

    // 关键改进：目录检测
    if (itemData.folder) {
      throw new Error("Requested path is a directory");
    }

    const downloadUrl = itemData["@microsoft.graph.downloadUrl"];

    if (!downloadUrl) {
      throw new Error("Failed to get download URL");
    }

    // 缓存下载URL
    await env.OD_CACHE.put(cacheKey, downloadUrl, { expirationTtl: 1800 });

    return downloadUrl;
  }

  // 路径匹配
  static isPathAllowed(path, allowedPatterns) {
    if (!allowedPatterns || allowedPatterns.length === 0) return true;

    // 标准化路径
    const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;

    return allowedPatterns.some((pattern) => {
      // 将通配符转换为正则表达式
      const regexPattern = pattern
        .replace(/\*\*/g, ".*") // ** 匹配任意字符（包括空）和任意多级目录
        .replace(/\*/g, "[^/]*") // * 匹配0个或多个非斜杠字符（单级）
        .replace(/\./g, "\\."); // 转义点号

      // 确保正则表达式匹配整个字符串
      const regex = new RegExp(`^${regexPattern}$`);

      // 同时匹配原始路径和标准化路径
      return regex.test(path) || regex.test(normalizedPath);
    });
  }

  // Markdown 渲染
  static async handleReadmeRender(downloadUrl) {
    try {
      // 获取Markdown内容
      const response = await fetch(downloadUrl);
      if (!response.ok)
        throw new Error(`Failed to fetch markdown: ${response.status}`);

      const markdownContent = await response.text();

      // 创建HTML响应
      const htmlContent = `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>文档预览</title>
          <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
          <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-okaidia.min.css">
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.2.0/github-markdown.min.css">
          <style>
            .markdown-body {
              box-sizing: border-box;
              min-width: 200px;
              max-width: 980px;
              margin: 0 auto;
              padding: 45px;
            }
            @media (max-width: 767px) {
              .markdown-body {
                padding: 15px;
              }
            }
            body {
              background-color: #f6f8fa;
            }
            .header {
              text-align: center;
              padding: 20px 0;
              border-bottom: 1px solid #eaecef;
              margin-bottom: 30px;
              background: white;
            }
            .render-info {
              text-align: center;
              color: #6a737d;
              font-size: 14px;
              margin-top: 20px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h2>文档预览</h2>
          </div>
          <div class="markdown-body">
            <div id="content"></div>
          </div>
          <div class="render-info">
            由OneDrive CDN服务渲染 • ${new Date().toLocaleString()}
          </div>
          <script>
            // 配置marked
            marked.setOptions({
              gfm: true,
              breaks: true,
              highlight: function(code, lang) {
                if (Prism.languages[lang]) {
                  return Prism.highlight(code, Prism.languages[lang], lang);
                }
                return code;
              }
            });
            
            // 渲染Markdown
            const markdownContent = ${JSON.stringify(markdownContent)};
            document.getElementById('content').innerHTML = marked.parse(markdownContent);
            
            // 自动为标题添加锚点
            document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
              const id = heading.textContent.toLowerCase().replace(/[^\\w]+/g, '-');
              heading.id = id;
              heading.innerHTML = \`<a href="#\${id}" class="anchor">#</a> \${heading.innerHTML}\`;
            });
            
            // 更新页面标题
            const firstHeading = document.querySelector('h1');
            if (firstHeading) {
              document.title = firstHeading.textContent + ' - 文档预览';
            }
          </script>
        </body>
        </html>`;

      return new Response(htmlContent, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (error) {
      return this.jsonResponse(
        {
          code: 500,
          message: "Markdown rendering failed",
          error: error.message,
          action: {
            retry: "Try again later",
          },
        },
        500
      );
    }
  }

  // 辅助方法
  static jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  // 令牌储存
  static async storeTokens(env, tokenData) {
    await env.OD_CACHE.put("access_token", tokenData.access_token, {
      expirationTtl: tokenData.expires_in - 300,
    });

    if (tokenData.refresh_token) {
      await env.OD_CACHE.put("refresh_token", tokenData.refresh_token);
    }

    await env.OD_CACHE.put(
      "token_meta",
      JSON.stringify({
        scope: tokenData.scope,
        expires_at: Date.now() + tokenData.expires_in * 1000,
        token_type: tokenData.token_type,
      })
    );
  }

  // AccessToken 获取
  static async getAccessToken(env, CONFIG) {
    const cachedAccessToken = await env.OD_CACHE.get("access_token");
    if (cachedAccessToken) return cachedAccessToken;

    const refreshToken = await env.OD_CACHE.get("refresh_token");
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    const tokenUrl =
      "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "Files.ReadWrite.All Sites.ReadWrite.All offline_access",
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Token refresh failed: ${errorData.error}`);
    }

    const tokenData = await response.json();
    await this.storeTokens(env, tokenData);
    return tokenData.access_token;
  }

  // 令牌刷新
  static async monitorTokenRefresh(env, CONFIG) {
    try {
      const tokenMeta = await env.OD_CACHE.get("token_meta");
      if (!tokenMeta) return false;

      const meta = JSON.parse(tokenMeta);
      if (Date.now() < meta.expires_at - 300000) return false;

      console.log("[TOKEN] Refreshing expired token");
      await this.getAccessToken(env, CONFIG);
      return true;
    } catch (e) {
      console.error("[TOKEN REFRESH ERROR]", CONFIG.development ? e.stack : null);
      return false;
    }
  }

  // 文件上传
  static async uploadToOneDrive(accessToken, filePath, fileData, CONFIG) {
    const cleanPath = filePath.startsWith("/")
      ? filePath.substring(1)
      : filePath;

    let apiEndpoint;
    if (CONFIG.sharepoint.siteId && CONFIG.sharepoint.driveId) {
      apiEndpoint = `https://graph.microsoft.com/v1.0/sites/${CONFIG.sharepoint.siteId}/drives/${CONFIG.sharepoint.driveId}/root:/${cleanPath}:/content`;
    } else {
      apiEndpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${cleanPath}:/content`;
    }

    const response = await fetch(apiEndpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: fileData,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Upload failed: ${errorData.error?.message}`);
    }

    const fileInfo = await response.json();

    return {
      downloadUrl: fileInfo["@microsoft.graph.downloadUrl"],
      webUrl: fileInfo.webUrl,
    };
  }

  // URL路径规范化
  static normalizePath(path) {
    // 解码URL编码字符
    let normalized = decodeURIComponent(path);

    // 替换多个斜杠为单个斜杠
    normalized = normalized.replace(/\/+/g, "/");

    // 移除开头和结尾的多余斜杠（保留根路径）
    if (normalized.length > 1) {
      if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
      if (normalized.startsWith("/")) normalized = normalized.substring(1);
    }

    // 重新添加前导斜杠
    return `/${normalized}`;
  }

  // API路径安全处理
  static sanitizeApiPath(path) {
    // 移除前导斜杠
    let clean = path.startsWith("/") ? path.substring(1) : path;

    // 编码特殊字符
    clean = encodeURIComponent(clean)
      .replace(/%2F/g, "/") // 保留斜杠
      .replace(/%20/g, " "); // 保留空格

    return clean;
  }

  // 防盗链
  static checkReferrer(request, securityConfig) {
    // 允许API请求直接通过
    if (request.url.includes("/application-retain/api")) {
      return { allowed: true };
    }

    const referrer =
      request.headers.get("Referer") || request.headers.get("Referrer");

    // 处理空Referrer
    if (!referrer) {
      if (securityConfig.emptyReferrerPolicy === "block") {
        return {
          allowed: false,
          reason: "Empty referrer not allowed",
        };
      }
      return { allowed: true };
    }

    // 解析Referrer URL
    let referrerHost;
    try {
      const referrerUrl = new URL(referrer);
      referrerHost = referrerUrl.hostname;
    } catch {
      return {
        allowed: false,
        reason: "Invalid referrer URL",
      };
    }

    // 检查是否允许直接访问
    if (
      securityConfig.blockDirectAccess &&
      referrerHost === request.headers.get("Host")
    ) {
      return {
        allowed: false,
        reason: "Direct access blocked",
      };
    }

    // 检查Referrer白名单
    if (securityConfig.allowedReferrers.length > 0) {
      const isAllowed = securityConfig.allowedReferrers.some((allowedRef) => {
        // 支持通配符域名 (*.example.com)
        if (allowedRef.startsWith("*.")) {
          const baseDomain = allowedRef.slice(2);
          return (
            referrerHost.endsWith("." + baseDomain) ||
            referrerHost === baseDomain
          );
        }
        return referrerHost === allowedRef;
      });

      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Referrer ${referrerHost} not in whitelist`,
        };
      }
    }

    return { allowed: true };
  }
}
