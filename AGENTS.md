# Project Instructions (meeting_asr_app)

## Git 工作流强制要求

- **禁止直接推送代码到 main/master 分支。**
- 任何功能/修复开发流程：
  1. 从 main 创建功能分支，命名规范：`feat-YYMMDD-NN-<描述>` 或 `fix-YYMMDD-NN-<描述>`（NN 为当日递增序号）
  2. 在分支上提交代码并推送
  3. **必须创建 Pull Request**，合并到 main 后才能算完成
- 例外：纯文档/配置类微调若用户明确表示可以直接推，则允许直接推送，但需要先询问用户。

## 其他约定

- 保持响应简洁。
- 提交信息使用中文，遵循 conventional commits 格式（feat/fix/docs/chore 等）。
