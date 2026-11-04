# 课堂考勤（KaoQin）

离线优先的 Android 课堂考勤工具。数据全部保存在本机，联网只用于「检查更新」。

- **包名**：`com.kaoqin.app`
- **技术栈**：Kotlin · Jetpack Compose · Room · Navigation
- **最低系统**：Android 12（API 31）
- **当前版本**：v0.0.28

## 功能

| 模块 | 说明 |
|---|---|
| 点名 | 上下半节分别记录；下半节默认跟随上半节（早退不记录、迟到按已到）；可按当前时间自动选节次，并按「星期几 + 节次」自动匹配上次那节课 |
| 记录 | 按学期 / 班级 / 课程 / 日期筛选，两半节分别查看，支持半节签到·早退时刻 |
| 统计 | 多维分组（班级 / 课程 / 地点 / 学生），状态多选，时长双口径（节次折算 / 个人跨度），排行与对比图 |
| 分数 | 固定分值或比例计分，正倒序，导出 CSV |
| 假条 | 长期与短期请假，精确到分钟，有效期内点名默认不再是缺勤 |
| 数据 | JSON 备份 / CSV 导出，按课程自动携带考勤痕迹；本地 CSV 文件库支持预览、编辑、批量删除 |
| 留痕 | 所有写操作可查，精确到秒 |
| 更新 | 应用内检查 / 下载 / 校验 / 安装，支持 GitHub 等公网托管与下载镜像 |

## 安装

从 [Releases](https://github.com/LinshaoBili/kaoqin/releases/latest) 下载最新的 `KaoQin-*-release.apk` 安装。

> 覆盖安装要求签名一致。若提示签名不符，只能卸载后重装，而卸载会清空数据——
> 请先用「管理 → 数据导入/导出」导出备份。

## 在线更新怎么配

应用需要一个「更新源」：一个能公开直链访问的目录，里面放 `version.json` 和 APK。

以 GitHub 为例（仓库需 **public**）：

1. `version.json` 放仓库根目录
2. APK 上传到 Releases
3. `version.json` 里的 `apkUrl` 写 Release 直链
   `https://github.com/<账号>/<仓库>/releases/latest/download/KaoQin-<版本>-release.apk`
4. 应用内「管理 → 软件更新」填更新源：
   - `https://raw.githubusercontent.com/<账号>/<仓库>/main`
   - `https://<账号>.github.io/<仓库>`（需开启 Pages）
   - `https://cdn.jsdelivr.net/gh/<账号>/<仓库>@main`（国内通常更快）

也可以用 Gitee / 阿里云 OSS / 腾讯云 COS，只要两个文件都能被公开直链访问。

### 发布一个新版本

```bash
# 1) 改 app/build.gradle.kts 的 versionCode / versionName，然后构建 release
JAVA_HOME="C:/Program Files/Java/jdk-17" \
  "C:/android-tools/gradle-8.7/bin/gradle.bat" :app:assembleRelease --offline

# 2) 写更新说明并生成清单（自动算 sizeBytes + sha256，生成 Release 直链版 version.json）
python build-tools/publish_update.py --github LinshaoBili/kaoqin --notes "修复：xxx"

# 3) 一条命令发布：建 tag + Release、上传 APK、提交 version.json、回读校验
set GITHUB_TOKEN=github_pat_xxx
python build-tools/publish_release.py --repo LinshaoBili/kaoqin
```

脚本会自己处理这些情况：**空仓库**先落首个提交（否则建 tag 会 422）、Release 已存在则更新正文、
同名 asset 已存在则跳过（`--clobber` 覆盖）、同版本清单里已有的 `notes` 不会被清空。
其他开关：`--dry-run` 只看动作、`--draft` 建草稿、`--no-push` 只生成本地清单、
`--no-docs` 不同步 README/CHANGELOG。

发布完成会自证三件事：清单里的 `sha256` 与 APK 一致、`raw.githubusercontent.com` 能读到清单、
`releases/latest/download/<asset>` 能下载且大小相符——三项全过才算发完。

`publish_update.py --check` 可随时校验「清单 vs APK」是否一致。

## 构建

离线构建，依赖全部来自 `offline-repo/`：

```bash
JAVA_HOME="C:/Program Files/Java/jdk-17" \
  "C:/android-tools/gradle-8.7/bin/gradle.bat" :app:assembleDebug :app:assembleRelease --offline
```

产物在 `app/build/outputs/apk/`，交付副本在 `deliver/KaoQin-<版本>-{debug,release}.apk`。

## 数据安全

考勤数据是本应用唯一不可再生的资产，因此：

- Room 迁移与生成 schema 逐字核对，避免 `fallbackToDestructiveMigration` 静默清库
- 导出/导入做「行数 = 定义列数」自校验，防止「导得出去、导不回来」
- **升级前自动备份数据库**到 `files/backup/pre-update-<旧版本>/`
- 安装前校验签名，签名不符时提前警告（这种情况下强行更新会丢全部数据）

## 目录

```
app/src/main/java/com/kaoqin/app/
├── data/          # Room 实体、仓库、纯逻辑（时长/统计/匹配/更新规则）
├── ui/screens/    # 页面
├── ui/viewmodel/  # 状态与用例
└── ui/components/ # 通用组件
build-tools/       # 验证脚本与发布工具（Python）
```

## 许可

个人项目，未附许可协议。
