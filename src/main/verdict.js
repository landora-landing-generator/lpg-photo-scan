"use strict";

/**
 * One word per site for the table and Excel:
 *   error  — the site did not open;
 *   people — at least one image with a person;
 *   unsure — no people found, but some images were ambiguous or not checked;
 *   clean  — every image checked, no people.
 */
function verdictOf(result) {
  if (result.error) return "error";
  if (result.people.length > 0) return "people";
  if (result.unsure.length > 0 || result.unchecked > 0) return "unsure";
  return "clean";
}

const VERDICT_TEXT = {
  people: "Есть люди",
  unsure: "Проверить глазами",
  clean: "Людей нет",
  error: "Сайт не открылся",
};

module.exports = { verdictOf, VERDICT_TEXT };
