"use strict";

/** A person in a frame: "face" (recognisable) or "body" (hands, back, silhouette). Old results had no kind — a face. */
const personKind = (img) => (img.kind === "body" ? "body" : "face");

/**
 * One word per site for the table and Excel:
 *   error  — the site did not open;
 *   faces  — at least one image with a recognisable face;
 *   people — people, but no face (hands, figures from behind);
 *   unsure — no people found, but some images were ambiguous or not checked;
 *   clean  — every image checked, no people.
 */
function verdictOf(result) {
  if (result.error) return "error";
  if (result.people.some((img) => personKind(img) === "face")) return "faces";
  if (result.people.length > 0) return "people";
  if (result.unsure.length > 0 || result.unchecked > 0) return "unsure";
  return "clean";
}

const VERDICT_TEXT = {
  faces: "Есть лица",
  people: "Части людей",
  unsure: "Проверить глазами",
  clean: "Людей нет",
  error: "Сайт не открылся",
};

const countKind = (result, kind) => result.people.filter((img) => personKind(img) === kind).length;

module.exports = { verdictOf, VERDICT_TEXT, personKind, countKind };
