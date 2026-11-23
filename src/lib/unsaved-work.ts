/**
 * 「当前页面有未保存的转写」这一事实的**页面外**载体（issue #74-1）。
 *
 * 为什么需要它：`AppHeader` 在 root layout 里，拿不到首页的 `status` / `liveSegments`；
 * 而 `beforeunload` 只对整页卸载生效，Next 的客户端路由（<Link>）不触发它。
 * 所以用一个模块级标志把「有没有未保存的活」传给 header 和任何内部链接。
 *
 * 单实例前提：Next App Router 的客户端组件共享同一个模块图，所以模块级变量足够。
 */
let hasUnsavedWork = false;

export function setHasUnsavedWork(value: boolean): void {
  hasUnsavedWork = value;
}

export function getHasUnsavedWork(): boolean {
  return hasUnsavedWork;
}

/**
 * 有未保存转写时向用户确认是否离开。
 *
 * `confirm` 可注入是为了可测（Node 环境没有 window.confirm）。
 * 返回 true = 允许导航；false = 应 preventDefault。
 */
export function confirmLeaveIfUnsaved(
  message = "有未保存的转写，离开后会丢失。确定离开吗？",
  confirm: (message: string) => boolean = (text) => window.confirm(text),
): boolean {
  if (!hasUnsavedWork) return true;
  return confirm(message);
}
