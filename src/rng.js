// 确定性伪随机数：所有随机过程（社群发现访问顺序、零模型交换、边权重洗）都来自
// 固定种子的 mulberry32 流，档案保存种子即可逐位复现，不依赖 Math.random。

export function mulberry32(seed) {
  let state = Number.isSafeInteger(seed) ? seed >>> 0 : 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 给同一主种子派生互不重叠语义的子流（零模型第 k 张图等），盐值固定写入档案。
export function mixSeed(seed, salt) {
  let h = (Number.isSafeInteger(seed) ? seed : 0) >>> 0;
  h = Math.imul(h ^ (salt >>> 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function shuffled(rng, values) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function intBelow(rng, bound) {
  return Math.floor(rng() * bound);
}
