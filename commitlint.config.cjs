// GitHub adds " (#123)" to a squash-merged pull request's title. Titles may be 100 characters before that suffix, so
// config-conventional's header-max-length (which counts the suffix) is replaced by a rule that ignores it.
const MAX_HEADER = 100;

// Dependabot capitalises grouped updates' titles ("chore(deps): Bump the dev-patches group with 2 updates") whatever
// the configured prefix, and config-conventional rejects a sentence-case subject. Let just those through.
const DEPENDABOT_GROUP = /^chore\((deps|ci)\): Bump the \S+ group\b/;

module.exports = {
  extends: ["@commitlint/config-conventional"],
  ignores: [(message) => DEPENDABOT_GROUP.test(message)],
  plugins: [{
    rules: {
      "header-max-length-before-pr-number": ({ header }, when, max) => {
        const title = (header || "").replace(/ \(#\d+\)$/, "");
        return [title.length <= max, `header must not be longer than ${max} characters, not counting the " (#123)" GitHub adds on merge`];
      }
    }
  }],
  rules: {
    "header-max-length": [0],
    "header-max-length-before-pr-number": [2, "always", MAX_HEADER]
  }
};
