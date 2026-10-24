# drawsrv

个人使用的轻量 Excalidraw 自托管服务。官方 `@excalidraw/excalidraw` 组件保持原样，React wrapper 提供画布管理；Go 标准库服务提供静态文件、状态保存及 Git 历史。

- 画布列表、名称搜索、新建、重命名。
- 元素、图片、背景/网格设置、视图位置及每个画布的素材库一起保存。
- 默认连续 30 秒无修改后自动保存，每次新修改重新计时；连续编辑不会强制保存。手动保存、返回列表、打开历史、切到后台或恢复联网时仍立即尝试保存。
- 每次内容有变化的成功保存自动 Git commit，未变化的内容不产生提交。
- 最近 100 次历史可在网页中列出和恢复；恢复创建新提交，保留后续历史。全部历史可用 Git 查看。
- ETag 条件写入：多个标签页或设备冲突时停止上传，不静默覆盖；可导出当前内容后刷新。
- 默认 `127.0.0.1:8080`，由现有反代负责公网 HTTPS 和认证。无 Docker、数据库或 Node.js 常驻进程。

## 本地构建与运行

构建需要 Go 1.24+、Git 2.36+、Node.js 22.18+（或 24+）、npm。VPS 运行时只需要编译后的 Go 程序、前端静态文件和系统 Git。

```sh
cd drawsrv
make build
./bin/drawsrv -static ./web/dist -data ./data -listen 127.0.0.1:8080
```

浏览器打开 `http://127.0.0.1:8080`。首次运行会在空数据目录中创建独立 bare Git 仓库，使用本地提交身份 `drawsrv <drawsrv@localhost>`，无需配置全局 Git 用户，也不会推送到远程。

开发时先构建一次静态页面并启动 Go，再在另一终端运行 `npm --prefix web run dev`；Vite 将 `/api` 转发到 Go 服务。

```sh
make test
```

## 部署到 Linux VPS

在本地或 CI 构建，避免在小内存 VPS 安装前端依赖或执行打包：

```sh
npm --prefix web ci
npm --prefix web run build
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o bin/drawsrv .
```

ARM64 VPS 使用 `GOARCH=arm64`。将 `bin/drawsrv` 和整个 `web/dist/` 上传到 VPS，例如 `/opt/drawsrv/drawsrv` 和 `/opt/drawsrv/web/`。前端包含本地字体，不依赖默认字体 CDN。

```sh
/opt/drawsrv/drawsrv \
  -listen 127.0.0.1:8080 \
  -static /opt/drawsrv/web \
  -data /var/lib/drawsrv
```

参见 [systemd 示例](deploy/drawsrv.service)。先创建 `drawsrv` 系统用户，再安装服务文件；示例使用 `StateDirectory=drawsrv` 创建数据目录。程序文件和静态文件应由部署用户管理，对服务用户只读。

反代将整个站点（包括 `/api/`）转发到 `http://127.0.0.1:8080` 并启用身份认证。保留原始 `Host`，不要缓存 API、移除 `ETag`/`If-Match` 或转换 API JSON 响应。将反代请求体上限设置为至少 16 MiB；根路径部署，不支持 URL 子路径。服务本身不区分用户，所有获准访问者都能读写所有画布。

## 数据、内存与历史

`-data` 指向的目录本身是 bare Git 仓库，没有 working copy 或 index：

```text
data/
├── HEAD
├── objects/
├── refs/
├── config
└── drawsrv.lock          # 单进程锁，不属于提交内容
```

提交中的逻辑文件树为：

```text
HEAD
├── state.json           # 画布名称、更新时间和 blob ID 的轻量索引
├── <canvas-id>.json      # 名称、元素、设置、图片和素材库
└── ...
```

数据目录必须在静态目录之外；不要让反代直接公开数据目录，也不要将其放进代码仓库。首次初始化要求空目录，也可以使用新的空 bare 仓库。每个数据目录只允许一个服务进程，进程锁会在退出或崩溃后自动释放。

不提供旧 working-copy 格式的迁移。含 `.git/` 的旧数据目录会被明确拒绝，原目录保持不变；请为新版本指定新的空数据目录。

Go 保留画布列表的轻量元数据，并使用按 Git blob ID 索引的 LRU 缓存加速重复读取。画布内容缓存默认最多 4 MiB、64 项，两个限制同时生效；超过容量的单个画布不会缓存。可用 `-cache-mib` 调整字节预算，`-cache-mib=0` 禁用缓存。历史版本和当前版本共享此预算，不会随保存次数无限增长。列表直接使用元数据索引；缓存未命中时从 Git blob 加载。状态读写与 Git 提交串行执行，以限制同时存在的大对象。默认单画布最多 16 MiB（包含 base64 图片及 JSON 格式化开销），可用 `-max-canvas-mib` 调整。内存峰值仍随单画布大小增大，不能将 Go 的空闲内存占用视为大图保存时的上限。

保存使用 `hash-object`、`mktree`、`commit-tree` 写入不可变对象，再用带旧值校验的 `update-ref` 原子发布分支；不创建工作文件或 index。与 picomx 一样，Git 对 committed 对象和引用启用 `fsync`，隔离继承的 Git 环境及全局配置，禁用 hooks、签名和隐式自动维护。这里使用短生命周期 Git 子进程，空闲时不保留 Git 进程。

HEAD 指向的提交是唯一权威状态。发布前中断只会留下未引用对象；发布后重启直接读取提交中的索引，无需扫描画布、补记提交或回滚文件。ref 发布失败或结果不确定时服务停止读写，请排除磁盘或锁文件问题后重启。已有 Git 数据但 HEAD/ref 丢失时拒绝自动初始化，需要先修复引用。不要在服务运行时执行外部 Git 写操作或维护仓库。

systemd 示例的 `GOMEMLIMIT=64MiB` 是 Go 运行时的软目标，并非服务或 Git 子进程的硬上限。Git 隐式自动维护仍保持关闭，daemon 会协调自己的 maintenance：首次 Git 写入后标记 dirty，默认 10 分钟后执行一次前台 `git gc --prune=never`，后续写入不推迟这个时间。维护成功后清除 dirty，没有写入时不会反复 GC；启动时也会安排一次，以覆盖上次进程退出前的写入。可用 `-maintenance-delay=30m` 调整，`-maintenance-delay=0` 禁用。

维护和 API 读写共用互斥锁，不会同时操作仓库。请求正忙时延后 1 分钟，维护失败保留 dirty 并在 5 分钟后重试；维护期间 API 请求可能等待。Git packing 使用单线程，window 和 delta cache 各限制为 8 MiB，单次维护最多 5 分钟；这些设置不是整个 Git 进程的硬内存上限。SIGTERM/中断会取消并回收维护子进程，再关闭服务和仓库锁。

GC 保留所有历史，不负责限制历史的磁盘总量。含图片的频繁保存仍会增加磁盘占用；也可在服务停止时按需运行：

```sh
git --git-dir=/var/lib/drawsrv -c pack.threads=1 -c pack.windowMemory=8m gc --prune=never
```

备份整个 bare 仓库目录。为获得一致备份，先停止服务或使用文件系统快照。Git 历史不替代异机备份。

网页展示最近 100 次提交；更早的历史仍保留在 Git：

```sh
git --git-dir=/var/lib/drawsrv log --oneline -- <canvas-id>.json
git --git-dir=/var/lib/drawsrv show <commit>:<canvas-id>.json
git --git-dir=/var/lib/drawsrv show HEAD:state.json
```

## 当前边界

这是个人文档保存工具，不提供实时协作、多用户隔离或在线账号管理。没有 service worker，也不依赖原官网的 Firebase、分享或协作后端。素材库按画布保存。

浏览器在网络失败时保留当前编辑并显示错误，可重试或导出备份；离开页面时会尝试提示未保存内容。不会将正在编辑的内容另存为持久化的浏览器离线草稿。首次从原 Excalidraw 迁移时，导出 `.excalidraw` 文件，在新建画布中使用编辑器的打开功能导入；素材库可单独从文件导入。
