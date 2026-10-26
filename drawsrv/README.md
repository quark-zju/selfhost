# drawsrv

把 Excalidraw 画布保存在自己的服务器上，在电脑、平板之间接着画。

- 跨客户端同步
- 回收站
- Git 历史记录
- 中英双语

## 如何使用

打开主页，新建画布，修改会自动保存。如果多设备打开同一画布，回自动实时同步。多端修改发生冲突时，页面会提示处理。

### 本地运行

需要 Go 1.24+、Git 2.36+ 和 make。仓库附带已构建的网页，运行时无需 npm。

在仓库的 `drawsrv` 目录执行：

```sh
make build
./bin/drawsrv -static ./web/dist -data ./data
```

打开 <http://127.0.0.1:8224>。首次运行会创建数据目录；画布和历史都保存在其中。

### 部署到 VPS

在 Linux VPS 上准备好 Go、Git 和 make，然后执行：

```sh
make deploy
# sudoedit /etc/drawsrv/drawsrv.env
make restart
```

默认监听 `127.0.0.1:8224`，由反代（如 picosrv）提供 HTTPS 和身份认证。

配置文件位于 `/etc/drawsrv/drawsrv.env`，数据默认保存在 `/var/lib/drawsrv/`。可参考[配置示例](deploy/drawsrv.env.example)调整监听地址、保存间隔和内存预算。修改配置后执行 `make restart`，用 `make status` 查看运行状态。

## 简要技术说明

前端使用官方 Excalidraw React 组件；Go 服务负责网页、保存和同步通知，无需数据库或 Docker。字体从公共 CDN 按需加载。

修改先暂存在服务端内存中，画布空闲 30 秒后落盘并记录 Git 历史；手动保存会立即落盘，正常退出也会保存待处理内容。异常中断仍可能丢失尚未落盘的修改。历史保存在数据目录的 bare Git 仓库中，可用 `git --git-dir=/var/lib/drawsrv log` 查看。

前端开发和 npm 构建在开发机器上进行：`make web` 更新网页，`make test` 运行测试。日常只提交源码，准备部署更新时才提交新的 `web/dist`。VPS 使用这些预编译网页，仅进行 Go 编译。
