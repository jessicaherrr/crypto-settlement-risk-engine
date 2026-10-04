/** Joins conditional class names - a 3-line stand-in for clsx, since
 * nothing here needs clsx's full argument shapes (arrays, objects). */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
