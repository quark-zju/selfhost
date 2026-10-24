# drawsrv

个人使用的轻量 Excalidraw 自托管服务。官方 `@excalidraw/excalidraw` 组件保持原样，React wrapper 提供画布管理；Go 标准库服务提供静态文件、状态保存及 Git 历史。

- 画布列表、名称搜索、新建、重命名。
- 元素、图片及每个画布的素材库由服务端保存和同步。整个 `appState`（包括滚动位置、缩放、背景和网格设置）只按画布保存在当前标签页的 `sessionStorage` 中；刷新后保留，各标签页和设备可使用不同设置。关闭标签页后不保证保留。
- 两级保存：浏览器无固定等待，下一次事件循环上传；同一轮及请求在途期间的修改合并发送，Go 内存接收最新快照；每个画布连续 30 秒无内容变化后再提交 Git。持续编辑也会同步，但不会定时强制创建 Git 提交。
- 手动保存、返回列表会同步并立即落盘；切到后台或恢复联网只立即同步，不强制生成历史。正常关闭 daemon 时提交全部待落盘状态。
- 保存状态只记录在浏览器 `console.log`，页面不显示状态标签。日志区分内存同步与持久化，连续相同状态不会重复输出。自动落盘由 SSE 推送通知，手动落盘也可直接读取请求响应。
- 每次内容有变化的落盘生成 Git commit，重复上传不重置空闲计时，未变化的内容不产生提交。
- 网页不提供历史面板；服务端保留全部 Git 历史，需要时用 Git 查看或导出旧快照。
- 条件修改列表：按元素提交新增、删除和字段组的旧值/新值；不同元素、同元素不重叠的字段可并发保存。服务端逐项返回 apply/drop；有 drop 时保留本地内容、提示导出备份后手动刷新。
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

参考同仓库 picosrv / picomx，Makefile 提供账号、配置和 systemd 安装入口。为了避免小内存 VPS 执行前端打包，构建与安装分开：`make deploy` 只安装已有产物，不调用 Go 或 npm。

在本地或 CI 生成部署包：

```sh
make release                       # 默认 Linux amd64
make release TARGET_ARCH=arm64     # ARM64 VPS
```

将 `dist/drawsrv-linux-amd64.tar.gz`（或 arm64 包）上传到 VPS。包内包含 Go 程序、全部静态文件、部署模板和 Makefile，VPS 只需 Git 2.36+、make、tar、sudo 和 Linux 账号/systemd 工具：

```sh
tar -xzf drawsrv-linux-amd64.tar.gz
cd drawsrv
make deploy
sudoedit /etc/drawsrv/drawsrv.env
make enable                        # systemctl enable --now drawsrv.service
make status
```

`make deploy` 创建系统用户/组并安装文件、刷新 systemd，但不会自动启动或重启服务。配置文件已存在时保留原文件。以 root 身份安装时可设置 `SUDO=`。

默认安装位置：

| 内容          | 路径                                           |
| ------------- | ---------------------------------------------- |
| 程序          | `/usr/local/bin/drawsrv`                       |
| 静态页面      | `/usr/local/share/drawsrv/web/`                |
| 配置          | `/etc/drawsrv/drawsrv.env`                     |
| systemd unit  | `/etc/systemd/system/drawsrv.service`          |
| bare Git 数据 | `/var/lib/drawsrv/`，由 systemd 创建并限制权限 |

配置示例见 [drawsrv.env.example](deploy/drawsrv.env.example)，支持调整监听地址、画布上限、读取缓存/待落盘缓冲预算、Git 提交空闲时间、maintenance 延迟及 Go 软内存目标。修改配置后运行 `make restart`。

升级时在新的部署包目录执行 `make deploy && make restart`。程序经临时文件原子替换；静态资源先复制，最后原子发布 `index.html`，保留旧的哈希资源以便已打开的页面继续使用。数据仓库和已有 `.env` 配置不被覆盖；unit 会从模板重新安装，systemd 个性化配置请放在 drop-in 中。旧静态资源不自动删除，可在停服后按需清理，避免长期多次部署占用磁盘。

可单独执行 `make install`、`make setup-user`、`make install-config`、`make install-systemd`。通过 `PREFIX`、`SHARE_DIR`、`CONFIG_DIR`、`SYSTEMD_DIR`、`SERVICE_USER`、`SERVICE_GROUP` 覆盖安装位置和账号，生成的 unit 使用相应运行路径。`DESTDIR` 用于离线打包/暂存安装，不进入 unit 内的运行路径，也不会调用 systemctl。

```sh
make help
make test-deploy                   # 无需 root/systemd，验证暂存安装、升级与配置保留
```

直接运行仍然可用：

```sh
./bin/drawsrv -static ./web/dist -data ./data -listen 127.0.0.1:8080
```

反代将整个站点（包括 `/api/`）转发到 `http://127.0.0.1:8080` 并启用身份认证。保留原始 `Host`，不要缓存 API、移除 `ETag`/`If-Match` 或转换 API JSON 响应。将反代请求体上限设置为至少 32 MiB（修改列表可能同时携带旧值与新值）；根路径部署，不支持 URL 子路径。服务本身不区分用户，所有获准访问者都能读写所有画布。

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
├── <canvas-id>.json      # 名称、元素、图片和素材库
└── ...
```

`appState` 不参与上传、ETag、SSE 内容通知或 Git 提交。读取和恢复旧版本时忽略其中的 `appState`，已有 Git 历史保持原样；手动导出的 `.excalidraw` 备份仍包含当前客户端的导出设置。浏览器存储不可用时使用默认视图，不影响画布保存。

数据目录必须在静态目录之外；不要让反代直接公开数据目录，也不要将其放进代码仓库。首次初始化要求空目录，也可以使用新的空 bare 仓库。每个数据目录只允许一个服务进程，进程锁会在退出或崩溃后自动释放。

不提供旧 working-copy 格式的迁移。含 `.git/` 的旧数据目录会被明确拒绝，原目录保持不变；请为新版本指定新的空数据目录。

Go 保留画布列表的轻量元数据，并使用按 Git blob ID 索引的 LRU 缓存加速重复读取。画布内容缓存默认最多 4 MiB、64 项，两个限制同时生效；超过容量的单个画布不会缓存。可用 `-cache-mib` 调整字节预算，`-cache-mib=0` 禁用缓存。历史版本和当前版本共享此预算，不会随保存次数无限增长。列表直接使用元数据索引；缓存未命中时从 Git blob 加载。状态读写与 Git 提交串行执行，以限制同时存在的大对象。默认单画布最多 16 MiB（包含 base64 图片及 JSON 格式化开销），可用 `-max-canvas-mib` 调整。内存峰值仍随单画布大小增大，不能将 Go 的空闲内存占用视为大图保存时的上限。

待落盘快照与 LRU 读取缓存分开管理。默认总负载最多 16 MiB、64 个画布，每个画布仅保留最新快照；通过 `-pending-mib` 调整总预算，`-commit-delay` 调整每个画布的空闲落盘时间。任意一个设为 0 时，上传立即落盘。超过缓冲预算的单个快照也直接落盘；缓冲满时先提交最久未修改的待落盘快照，不能像读取缓存一样直接淘汰。磁盘/Git 失败时保留已确认的数据，新上传若无法容纳则返回错误，由客户端继续保留并重试。

内存接收不执行 Git 命令；读取、列表和条件修改都基于内存中的最新快照。`PUT /api/canvases/<id>` 返回 `202` 表示已同步到内存，`204` 表示已落盘；响应通过 `ETag` 和 `X-Drawsrv-Persisted` 明确版本和持久化状态。`GET .../status` 保留为诊断接口，客户端不轮询；`POST .../flush` 配合 `If-Match` 立即落盘。自动落盘保持 ETag 不变，不会制造额外的版本冲突。创建画布仍立即落盘。兼容的历史/恢复 API 保留给已有调用方，网页不再使用；恢复前会提交已接收的草稿。

`GET /api/canvases/<id>/events` 建立 SSE 通知连接，推送 `state`（首次连接/重连的当前状态）、`change`（内存内容变化）、`persisted`（落盘完成）。通知只包含 ETag、有效内容 HASH、独立修订标识、持久化状态及客户端来源，不包含画布快照。客户端通过 `X-Drawsrv-Client` 标记自身写入，并统一比较有效 HASH：相同则继续编辑；不同且本地有未确认修改则先提交修改列表；不同且本地无未确认修改则 GET 最新快照，并通过 Excalidraw `updateScene(..., captureUpdate: NEVER)` 原地应用，保持页面和编辑器实例；未变化元素复用原对象，删除元素保留内部墓碑供撤销机制识别，滚动、缩放和仍有效的选择保持本地值。保存、异步计算 HASH、拉取快照期间产生的新编辑会再次检查，不会直接丢弃；拖拽、编辑文字/线条、输入画布名称时延后原地更新，操作结束后再继续。应用快照时短暂锁定编辑器输入并屏蔽远端回调，更新保存基准，避免回传远端内容。拉取到比最新 SSE 更旧的快照会重新拉取，已关闭的页面不再应用响应。尚未同步的编辑仍受浏览器离开提示保护。

图片新 ID 通过 `addFiles()` 补充，素材库通过 `updateLibrary()` 替换。组件的 `addFiles()` 不支持覆盖已有 ID，因此同 ID 图片内容改变时只重建编辑器组件，保留页面、保存队列和视图，组件撤销栈会清空；普通远端更新不清空撤销栈，也不加入本地撤销记录。该边界会写入 console。网络仍拉取完整快照（包含 base64 图片），没有引入服务端增量事件历史。

SSE 取消了周期性状态查询，断线由浏览器自动重连，并以当前状态补齐通知；不重放断开期间的全部中间事件。每个连接只缓冲最新一条通知，最多同时 64 个连接，慢客户端不会阻塞保存或无限堆积通知。每 15 秒发送保活注释，单次写通知限时 10 秒；退出服务时主动关闭所有事件流，避免阻塞优雅关闭。反代需要支持流式响应并保留较长的连接空闲超时；服务设置 `X-Accel-Buffering: no`，picosrv 已支持 SSE 即时转发。

独立修订标识在相同内容被重新编辑/还原时也会变化，防止较早的落盘事件误确认新的草稿；即使 SSE 落盘通知早于上传响应到达，客户端也会保留并正确关联这次确认。通知驱动内容检查与条件保存，不提供编辑租约或 CRDT 实时协作。冲突副本停止自动同步和自动刷新，需用户先导出备份再手动处理。

客户端根据上次确认的本地内容生成修改列表，默认下一次事件循环即尝试上传，期间的连续修改合并为最新状态，通过 `POST /api/canvases/<id>/changes` 上传；无需上传整个 merge base 或保留中间 Git 提交。元素新增/删除按 ID 处理；同一元素本次修改的所有字段组成一项，前提全部相容才整项应用。当前值已等于目标值时视为成功，以支持丢失响应后的重试。名称、图片和素材库条目也有条件检查；图层顺序单独比较共有元素的相对顺序，保留其他客户端新增的元素。响应返回已应用的索引、已丢弃的索引及原因、有效 HASH；有任意 drop 就保留客户端原图并显示冲突提示。服务端先在候选副本上检查，再整体交给原有两级保存缓冲；无效请求或候选状态超限不部分发布。每次最多 4096 项修改，请求体最多为单画布大小上限的两倍，结果仍受单画布大小上限约束。

关联到不存在元素/图片的元素修改会丢弃；若一项新增被丢弃，依赖它的新增也会被检查并丢弃。删除元素会清理仍指向它的旧绑定，正在被引用的图片不会被删除。同一元素的字段组原子性不等同于整次用户手势跨多个元素的事务：仍可能部分成功，因此冲突后必须保留并导出本地副本。

`updated`、`version`、`versionNonce` 由服务端在有效元素变化时维护，客户端不上传它们；无内容变化的重试不更新时间、版本或空闲落盘期限。有效 HASH 对名称、元素、图片和素材库做跨 Go/JavaScript 一致的 SHA-256，忽略元素的这三个记账字段、图片的 `created`/`lastRetrieved`、素材库条目的 `created`，并把空绑定规整为 `[]`。`customData` 中同名字段仍属于有效内容。HASH 包含元素及素材库顺序，区分字段缺失与显式 null；对象键顺序、JSON 格式及时间戳不会产生差异。HASH 通过 `X-Drawsrv-Hash` 和 SSE 返回，与用于兼容条件整图写入的 ETag、用于识别通知时序的 revision 分开。同步决策、HASH 比较、apply/drop 数量和原因写入 `console.log`。

查看服务器历史时可用：

```sh
git --git-dir=/var/lib/drawsrv log -- <canvas-id>.json
git --git-dir=/var/lib/drawsrv show <commit>:<canvas-id>.json > snapshot.json
```

待落盘数据的空闲计时从最后一次内容变化开始，写入失败至少等待 5 秒后重试。服务退出时先停止接收新请求，再提交剩余快照，最后释放仓库锁；退出落盘失败会明确报错。内存同步尚不能抵御进程崩溃、SIGKILL、断电；连续编辑会延后落盘，因此 30 秒不是最大可能丢失时间。客户端当前也没有持久化的离线草稿。

保存使用 `hash-object`、`mktree`、`commit-tree` 写入不可变对象，再用带旧值校验的 `update-ref` 原子发布分支；不创建工作文件或 index。与 picomx 一样，Git 对 committed 对象和引用启用 `fsync`，隔离继承的 Git 环境及全局配置，禁用 hooks、签名和隐式自动维护。这里使用短生命周期 Git 子进程，空闲时不保留 Git 进程。

运行期间读取以已接收的最新内存快照为准；重启恢复以 HEAD 指向的提交为准。发布前中断只会留下未引用对象；发布后重启直接读取提交中的索引，无需扫描画布、补记提交或回滚文件。ref 发布失败或结果不确定时服务停止读写，请排除磁盘或锁文件问题后重启。已有 Git 数据但 HEAD/ref 丢失时拒绝自动初始化，需要先修复引用。不要在服务运行时执行外部 Git 写操作或维护仓库。

systemd 示例的 `GOMEMLIMIT=64MiB` 是 Go 运行时的软目标，并非服务或 Git 子进程的硬上限。Git 隐式自动维护仍保持关闭，daemon 会协调自己的 maintenance：首次 Git 写入后标记 dirty，默认 10 分钟后执行一次前台 `git gc --prune=never`，后续写入不推迟这个时间。维护成功后清除 dirty，没有写入时不会反复 GC；启动时也会安排一次，以覆盖上次进程退出前的写入。可用 `-maintenance-delay=30m` 调整，`-maintenance-delay=0` 禁用。

维护和 API 读写共用互斥锁，不会同时操作仓库。请求正忙时延后 1 分钟，维护失败保留 dirty 并在 5 分钟后重试；维护期间 API 请求可能等待。Git packing 使用单线程，window 和 delta cache 各限制为 8 MiB，单次维护最多 5 分钟；这些设置不是整个 Git 进程的硬内存上限。SIGTERM/中断会取消并回收维护子进程，再关闭服务和仓库锁。

GC 保留所有历史，不负责限制历史的磁盘总量。含图片的频繁保存仍会增加磁盘占用；也可在服务停止时按需运行：

```sh
git --git-dir=/var/lib/drawsrv -c pack.threads=1 -c pack.windowMemory=8m gc --prune=never
```

备份整个 bare 仓库目录。文件系统快照只包含已落盘版本；要包含全部已接收内容，请先正常停止服务（会提交待落盘内容），或先显式 flush。Git 历史不替代异机备份。

服务端保留全部提交，可直接用 Git 查看：

```sh
git --git-dir=/var/lib/drawsrv log --oneline -- <canvas-id>.json
git --git-dir=/var/lib/drawsrv show <commit>:<canvas-id>.json
git --git-dir=/var/lib/drawsrv show HEAD:state.json
```

## 当前边界

这是个人文档保存工具，不提供实时协作、多用户隔离或在线账号管理。没有 service worker，也不依赖原官网的 Firebase、分享或协作后端。素材库按画布保存。

浏览器在上传失败时保留当前编辑并在 console 记录错误，冲突时显示备份/刷新提示，可重试或导出备份；离开页面时会尝试提示尚未同步的内容。不会将正在编辑的内容另存为持久化的浏览器离线草稿。首次从原 Excalidraw 迁移时，导出 `.excalidraw` 文件，在新建画布中使用编辑器的打开功能导入；素材库可单独从文件导入。
