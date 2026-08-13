export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": ["error", "always", 100],
    "footer-max-line-length": ["error", "always", 100],
    "header-max-length": ["error", "always", 100],
  },
};
