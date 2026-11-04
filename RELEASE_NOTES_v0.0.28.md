# 考勤 App v0.0.28 — 在线更新

这是本项目的**第一个自更新版本**。装上这一版之后，以后有新版本不用再找电脑传包，
在应用里点一下即可升级。

## 这一版做了什么

**在线更新**
管理 → 软件更新 → 填更新源地址 → 保存并检查。发现新版本后点「立即更新」，
下载完成后会自动校验并拉起系统安装界面。

- 更新源可以是 GitHub Releases / GitHub Pages / 仓库 raw / jsDelivr / Gitee / OSS，也可以是局域网
- 下载完自动校验包名、版本号、**签名摘要**；校验不过自动删包，不会把坏包装进手机
- 边下边算 SHA-256；下载失败自动重试 2 次（每次间隔递增）
- 显示实时速度与剩余时间；退出更新页下载也不会中断

**启动时静默检查**
打开应用会在后台查一次（一个进程一次、6 小时内不重复、没配更新源就完全不发请求）。
只有真发现新版本才会在管理页出现提示条，失败和「已最新」都不打扰。

**下载镜像（可选）**
国内访问 GitHub 慢，可以填一个加速前缀。镜像只用于下载 APK，清单始终直连——
因为清单里的 `sha256` 必须来自可信源。如果开了镜像但清单没有完整 `sha256`，
应用会**拒绝下载**：没有摘要就无法确认包没被替换。

**安装前自动备份**
每次安装新版本之前，会把数据库快照到 `Android/data/com.kaoqin.app/files/backup/pre-update-<旧版本>/`。
新版如果出问题，数据还在。

**另外修了一个考勤规则**
上半节标「迟到」的学生，下半节不再继承迟到，默认按「已到」处理。
迟到是一次事件而不是持续状态，机械继承会把同一次迟到扣两遍（人次、分数、时长三处都会放大）。
下半节确实又迟到的，仍然可以**手动点**「迟到」。

## 怎么配置更新源

以 GitHub 为例（仓库需 public）：

1. 仓库根目录放 `version.json`， Releases 里上传 APK
2. `version.json` 的 `apkUrl` 填 Release 直链：
   `https://github.com/<你的账号>/<仓库>/releases/latest/download/KaoQin-0.0.28-release.apk`
3. 更新源填其中之一：
   - `https://raw.githubusercontent.com/<账号>/<仓库>/main`
   - `https://<账号>.github.io/<仓库>`（需开启 Pages）
   - `https://cdn.jsdelivr.net/gh/<账号>/<仓库>@main`（国内通常更快）

`version.json` 示例：

```json
{
  "versionCode": 28,
  "versionName": "0.0.28",
  "apkUrl": "https://github.com/LinshaoBili/kaoqin/releases/latest/download/KaoQin-0.0.28-release.apk",
  "sizeBytes": 42206508,
  "sha256": "ec673c821504d703dfa0c19256ce77aeddf0754b5f5b5b56c68f0701c7d1d306",
  "publishedAt": "2026-11-04",
  "notes": ["修复…", "新增…"]
}
```

`sizeBytes` 与 `sha256` 请用 `build-tools/publish_update.py` 生成，**不要手填**。

## 安装说明

- 覆盖安装需要与已安装版本**签名一致**。若提示签名不符，只能卸载后重装，
  而卸载会清空数据——请先用「管理 → 数据导入/导出」导出备份
- 首次在应用内安装，系统会要求允许本应用「安装未知应用」，应用会直接把你送到那个设置页
- 系统安装确认框必须手动点一下（Android 安全边界，无法绕过）

## 已知限制

- 全量下载约 40MB，无增量更新
- 「重要更新」只加强提示措辞，不阻止使用（上课时被弹窗挡住不能点名，比漏更新更严重）

---

**完整变更**：[CHANGELOG.md](https://github.com/LinshaoBili/kaoqin/blob/main/CHANGELOG.md)
