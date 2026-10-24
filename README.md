# selfhost

我个人维护和使用的 self-host 工具集合。

- [picosrv](picosrv/README.md)：轻量 HTTPS 反向代理与静态文件服务，支持身份认证、证书热加载、WebSocket 和 SSE。
- [picomx](picomx/README.md)：面向个人域名的轻量收信服务，提供 SMTP 收信、Git 邮件存档和 POP3S 访问。

各工具的配置、构建和部署方式见对应 README；请在各自子目录内运行命令。

这两个项目通过 `git subtree` 导入，保留完整提交历史。后续可从本地源仓库更新：

```sh
git subtree pull --prefix=picosrv ~/src/picosrv HEAD
git subtree pull --prefix=picomx ~/src/picomx HEAD
```
