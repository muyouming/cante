// 「这台电脑能不能读写表格」的面向用户中文，以及一个判断哪些文件是 Excel 的
// 小工具。
//
// 单独一个文件，是为了不去动别的 workstream 正在改的 copy.ts。这里的中文一律
// 平实、零术语：说明白现在能做什么，做不到时给两条能走的路，而不是吓人的报错。

export const SHEET_COPY = {
  /**
   * 不能读写 Excel 时，确认页上给用户看的一句边界说明。
   *
   * 这是"做不到"，不是"出错了"——所以文案里没有"失败""错误"这类词，语气也保持
   * 在中性的陈述上。
   */
  fallbackNote:
    "这台电脑还不能直接读写 Excel 文件。你可以把表先另存成 CSV 再交给我，或者请技术同事帮忙装一次表格工具。",
} as const;

/** 会被当成 Excel 文件的扩展名。 */
const EXCEL_EXTENSIONS = [".xlsx", ".xls"] as const;

/**
 * 选中的文件里有没有 Excel 文件。只看扩展名，够用而且不会误报。
 */
export function hasExcelFile(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const lowered = path.toLowerCase();
    return EXCEL_EXTENSIONS.some((extension) => lowered.endsWith(extension));
  });
}
