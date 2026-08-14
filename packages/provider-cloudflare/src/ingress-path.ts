const pathExpression = /^\/[A-Za-z0-9._/-]{1,511}$/u;

/** Exact host-owned ingress path policy shared by both Cloudflare data-plane surfaces. */
export const cloudflareIngressPathIsValid = (value: string): boolean =>
  pathExpression.test(value) &&
  !value.includes("//") &&
  !value.split("/").some((segment) => segment === "." || segment === "..");
