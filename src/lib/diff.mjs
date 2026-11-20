/**
 * 快照对比：给每个仓库标出相对上一次成功快照的位置变化。
 * 纯函数。首次使用（没有上一份快照）时一律不标 isNew，避免整榜都被当成新上榜。
 */

/**
 * @param {Array<object>} repos 当前榜单（顺序即排名）
 * @param {Array<object>|null} previous 上一次快照里的 repos
 * @returns {{ repos: Array<object>, dropped: Array<object>, isFirstRun: boolean }}
 */
export function diffSnapshot(repos, previous) {
  const list = Array.isArray(repos) ? repos : [];
  const firstRun = !Array.isArray(previous) || previous.length === 0;

  if (firstRun) {
    return {
      // 首次抓取也要给名次：榜单顺序本身就是排名，缺了它整行标题只剩仓库名，
      // 看起来像界面坏了。没有上一次快照时 rankDelta 为 null，不声称任何变化。
      repos: list.map((row, index) => ({
        ...row,
        rank: index + 1,
        previousRank: null,
        rankDelta: null,
        isNew: false,
      })),
      dropped: [],
      isFirstRun: true,
    };
  }

  // 坏行先剔除再算名次：我们自己写的快照不会有坏行，但读盘失败时留下半截
  // JSON 不该让整榜的排名整体错位。
  const previousValid = previous.filter((row) => row && typeof row.repo === "string");
  const previousRank = new Map();
  previousValid.forEach((row, index) => previousRank.set(row.repo, index + 1));

  const currentSet = new Set();
  const annotated = list.map((row, index) => {
    const rank = index + 1;
    currentSet.add(row.repo);
    const before = previousRank.get(row.repo) ?? null;
    return {
      ...row,
      rank,
      previousRank: before,
      // 正数 = 上升；null = 新上榜
      rankDelta: before === null ? null : before - rank,
      isNew: before === null,
    };
  });

  const dropped = previousValid
    .map((row, index) => {
      if (currentSet.has(row.repo)) return null;
      return { ...row, previousRank: index + 1 };
    })
    .filter(Boolean);

  return { repos: annotated, dropped, isFirstRun: false };
}

/** 榜单签名：只在内容真变化时才覆盖快照，避免「刷新一下日期就变」。 */
export function snapshotSignature(repos) {
  const list = Array.isArray(repos) ? repos : [];
  return list.map((row) => String(row && row.repo)).join("|");
}
