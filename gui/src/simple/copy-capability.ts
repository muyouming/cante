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

/**
 * 「这台电脑能不能处理 PDF」的面向用户中文。
 *
 * 同样一个文件：SHEET_COPY 管表格，这里管 PDF，互不干扰。缺工具是边界、不是报错，
 * 所以语气和中性的边界说明一致。
 */
export const PDF_COPY = {
  /** 不能处理 PDF 时，确认页上给用户看的一句边界说明。 */
  fallbackNote:
    "这台电脑还不能直接处理 PDF。你可以先把它导出成别的格式，或者请技术同事帮忙装一次 PDF 工具。",
} as const;

/**
 * 「这个设置能不能看图」的面向用户中文（#48）。
 *
 * 和表格/PDF 的缺工具不同：这里的边界不在于这台电脑装没装什么，而在于当前用的
 * 那个设置看不看得懂照片。所以文案要给出两条她真能走的路——先把内容写下来，或者
 * 请同事换一个能看图的设置。同样地，这是边界不是报错。
 */
export const VISION_COPY = {
  /** 看不了图片时，确认页上给用户看的一句边界说明。 */
  fallbackNote:
    "现在这个设置看不了图片。你可以把表拍清楚，再用文字把里面的内容写给我；或者请帮你配置这台电脑的同事换一个能看图的设置。",
} as const;

/** 会被当成图片文件的扩展名。 */
const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".webp",
  ".bmp",
  ".gif",
  ".tif",
  ".tiff",
] as const;

/**
 * 「王姐交来的文件，我读不了」怎么告诉她（#88）。
 *
 * 和上面 SHEET_COPY.fallbackNote 是**两件事**，别混：
 *   * fallbackNote 说的是这台电脑还没装工具——环境问题，装了就能读；
 *   * 这里说的是文件本身是 WPS / 苹果自己的格式——装了什么工具都读不了，
 *     但文件是好的，她今天在 WPS 里「另存为」一下就能继续。
 *
 * 所以这里不重复缺工具那句话，而是给一个她能立刻做完的动作（另存为），
 * 并且全程不说「失败」「错误」：这不是出错，是一个边界。
 */
export const FORMAT_COPY = {
  /** 一个都读不了时，那个醒目方框的标题。 */
  heading: "这几份文件我打不开",
  /** 全是 WPS 自己的格式：给一步就能做完的另存为。 */
  wpsConvertAdvice:
    "这是 WPS 自己保存的文件，不是 Excel 或 Word 文件，我打不开。请在 WPS 里打开它，点「另存为」，选「Excel 文件（.xlsx）」「Word 文件（.docx）」或「PowerPoint 文件（.pptx）」，再把新文件交给我就行。",
  /** 全是苹果自己的格式：同样是一步导出。 */
  appleConvertAdvice:
    "这是苹果电脑上的 Pages 或 Numbers 文件，我打不开。请在 Pages 或 Numbers 里打开它，点「导出」，导出成「Word 文件（.docx）」或「Excel 文件（.xlsx）」，再把新文件交给我就行。",
  /** 全读不了，而且 WPS 的和苹果的混在一起：给不出一条统一的另存为。 */
  mixedConvertAdvice:
    "这些文件我一种也打不开：WPS 自己的格式和苹果自己的格式，我都读不了。请把它们各自打开，WPS 的点「另存为」、苹果的点「导出」，都存成 Excel 文件（.xlsx）或 Word 文件（.docx），再把新文件交给我。",
  /** 混着能读的文件：说清会跳过哪几份、其余照做。 */
  skipSomeAdvice:
    "这几份我读不了，会先跳过，其余的照做；做完会告诉你跳过了哪几份。",
  /** 一个都读不了时，开始按钮旁边那句「为什么现在别开始」。 */
  startBlocked:
    "先别开始：这几份文件我打不开，现在开始也拿不到结果。先按上面的办法另存一份，再交给我。",
  /**
   * 选文件那一步的一句话：几份打不开（都打不开、而且只有一份时单独说）。
   *
   * 只说「有几份打不开」，出路放在「怎么办」那个展开里——选文件这一步不该用
   * 一大段话把屏幕占满。
   */
  pickLine: (blocked: number, total: number): string => {
    if (blocked < total) return `你选的 ${total} 份里，有 ${blocked} 份我打不开`;
    return total === 1 ? "你选的这份我打不开" : `你选的 ${total} 份我都打不开`;
  },
  /** 选文件那一步「怎么办」按钮上的字：点开看到的就是上面那几句里的出路。 */
  pickAdviceToggle: "怎么办",
} as const;

/** 会被当成 Excel 文件的扩展名。 */
const EXCEL_EXTENSIONS = [".xlsx", ".xls"] as const;

/** 会被当成 PDF 文件的扩展名。 */
const PDF_EXTENSIONS = [".pdf"] as const;

/**
 * 选中的文件里有没有 Excel 文件。只看扩展名，够用而且不会误报。
 */
export function hasExcelFile(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const lowered = path.toLowerCase();
    return EXCEL_EXTENSIONS.some((extension) => lowered.endsWith(extension));
  });
}

/**
 * 选中的文件里有没有 PDF。只看扩展名，够用而且不会误报。
 */
export function hasPdfFile(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const lowered = path.toLowerCase();
    return PDF_EXTENSIONS.some((extension) => lowered.endsWith(extension));
  });
}

/**
 * 选中的文件里有没有图片（照片、截图）。
 *
 * 只看扩展名，和上面两个同一个路子：够用，而且不会把别的文件误判成图片。
 */
export function hasImageFile(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const lowered = path.toLowerCase();
    return IMAGE_EXTENSIONS.some((extension) => lowered.endsWith(extension));
  });
}
