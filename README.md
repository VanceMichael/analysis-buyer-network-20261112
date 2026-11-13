# buyer-network

left/right 是脱敏机构键，amount 为非负合作规模。

项目目前提供本地记录校验、输入指纹和按 `relation` 的原始核算。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js analyze --input data/records.json --policy data/policy.json --out var/network-archive.json
node src/cli.js recheck --input data/records.json --archive var/network-archive.json
npm run demo
```

`npm run demo` 在本地打印输入、现有核算及配置并生成 `var/summary.json` 与网络分析档案，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 关系网络分析

`analyze` 按 `data/policy.json` 的窗口与口径把脱敏合作边投影为无向加权图，做加权 Louvain
社群发现（可调分辨率与目标社群数、多种子稳定性、成员集合稳定命名），计算跨社群桥贡献
（拓扑割边、介数、参与系数，结论可追溯到具体记录 id），并用**逐节点保持度序列**的双边
交换零模型检验桥地位是否独立于度数。零模型边权支持 `reshuffle`（边权重洗）与 `attached`
（桩跟随、强度守恒）两种策略；交换空间不足或成功交换不够时判无效并给诊断，不充当零模型。
`recheck` 凭档案重新读取同一网络复查全部口径与结果。方法细节见 `docs/network-analysis.md`。

## 容器

```sh
docker build -t buyer-network:local .
docker run --rm --network none buyer-network:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/graph.js`：窗口/关系过滤、无向加权建图、平行边合并、金额缩放与自环单列。
- `src/community.js`：加权 Louvain、分辨率与目标社群数、多种子稳定性、稳定命名。
- `src/bridges.js`：拓扑割边、介数、参与系数与跨社群边的记录级追溯。
- `src/nullmodel.js`：保度双边交换零模型、边权处置、有效性诊断与 FDR。
- `src/analysis.js`：分析编排、档案生成与复查。
- `src/cli.js`：本地读取、检查、分析、复查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、领域核对、网络分析、零模型诊断、命令与输出回归。
- `data/`：合成记录、独立核对值及本地业务配置。
