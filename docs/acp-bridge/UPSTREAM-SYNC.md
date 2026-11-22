# 跟官方 ZCode 更新（Claude 360 Code）

owner 2026-11-22：官方有新版本就把官方代码合进来，我们自己出新包；**不能用官方的自动更新**——官方安装包没有我们的改动，装上就变回官方 ZCode。

## 现状

- 我们的安装包构建期关闭自动更新（没有私有构建配置，`ZCODE_AUTO_UPDATE` 为空），也不恢复别人留下的「已下载待安装」（`index.ts` 里 `hydratePendingPostUpdateReleaseNotes` 只在开了自动更新时调用）。
- 官方开源仓只在发布开源版本时才更新；闭源正式版（如 3.19.1，2026-11-20）可能先于开源仓出现，**开源仓没有的版本我们合不了**。

## 步骤

1. 查有没有新版本：`bash scripts/acp-dev/check-upstream.sh`（`UPSTREAM_NEW` 才需要动）。
2. 拉官方：`git fetch upstream --tags`（网络断了重试；必要时 `git fetch upstream refs/tags/vX.Y.Z:refs/tags/vX.Y.Z`）。
3. 开分支合并：`git switch -c sync/vX.Y.Z main && git merge vX.Y.Z`（用 merge 不用 rebase：main 已推送、公开仓不改历史）。冲突优先保留我们带 `acp-bridge` / `ZCODE_C360` 注释的改动。
4. 验证：`grep -rn "acp-bridge(privacy)\|ZCODE_C360" packages apps | wc -l` 与合并前一致；类型检查；打 Mac + Windows 两个包。
5. 真机：装 Mac 包，确认打开不弹输密码、能选 Claude Code、插件市场有列表、顶栏没有官方「更新」。
6. 合回 main、推送；换下载区两个安装包（manifest 的 sha/size 一并改）；在 Claude 360 Manager 里提示客户更新（客户自己点下载新包）。
