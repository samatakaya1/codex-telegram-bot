export const REBOOT_EXIT_CODE = 42;

export function requestProcessReboot(exit: (code?: number) => never | void = process.exit): void {
  exit(REBOOT_EXIT_CODE);
}
