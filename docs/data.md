# 数据与现有口径

left/right 是脱敏机构键，amount 为非负合作规模。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `left` | `string` |
| `right` | `string` |
| `period` | `integer` |
| `amount` | `number` |
| `relation` | `string` |

现有 `summary` 按 `relation` 清点记录，`sum` 为 `amount` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`data/policy.json` 保存业务配置的演练值，当前清点命令不消费分析配置。

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；指纹不依赖字段或记录排列。数据版本不支持时应直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。

## 分析配置（`data/policy.json`）

`analyze` 消费以下口径字段，完整方法与诊断规则见 `docs/network-analysis.md`：

| 字段 | 含义 |
| --- | --- |
| `fromPeriod` / `toPeriod` | 建图时间窗口（含端点），留空表示不限制 |
| `relations` | 纳入的关系类型白名单，`null` 表示全部 |
| `parallelPolicy` | 平行边合并：`sum` / `count` / `max` / `mean` |
| `scale` | 金额缩放：`none` / `log1p`，作用于合并后金额 |
| `selfLoops` | `report-only`（默认，单列不进拓扑）或 `include`（仅计入强度） |
| `nodes` | 节点 universe，其中无边节点作为孤立点保留 |
| `resolution` | Louvain 模块度分辨率 γ |
| `targetCommunities` | 目标非孤立社群数，`null` 表示不约束 |
| `seeds` | 社群发现的固定种子数组，用于稳定性复核 |
| `hideAmounts` | 导出时隐藏一切单边金额字段，保留记录 id 可追溯性 |
| `nullRealizations` / `swapMultiplier` / `maxAttemptsPerSwap` | 零模型实现数、交换数下限倍率与单次交换尝试预算 |
| `nullWeightPolicy` | `reshuffle`（边权重洗）或 `attached`（桩跟随、强度守恒） |
| `allowCrossComponentSwaps` | 是否允许跨连通分量交换，默认 `false` |
| `nullSeedBase` | 零模型随机种子基数，与 `seeds` 一起保证可复现 |
