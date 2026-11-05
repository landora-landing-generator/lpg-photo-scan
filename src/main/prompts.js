"use strict";

/**
 * How every new frame is drawn. Shown to the user and editable in the app
 * ("Настройки — можно не трогать"); an empty field means this default. It goes
 * both to the model that describes the old frame and, appended, to the model
 * that draws — so the rules hold even for a description the user typed.
 */
const DEFAULT_REDRAW_RULES = [
  "Новая оригинальная фотография, которая делает на странице ту же работу, что старая:",
  "тот же сюжет и обстановка, тот же ракурс, кадрирование и настроение.",
  "Люди — обобщённые (возраст, одежда, действие), не похожие на конкретных реальных людей.",
  "Фотореализм, естественный свет.",
  "Без текста, букв, цифр, логотипов и водяных знаков.",
].join(" ");

/**
 * Added to the rules when the old frame is a cut-out (no background, or a plain
 * white field): the new one must drop into the same design. It outranks the
 * "same setting" rule above — a cut-out has no setting to keep.
 */
const CUTOUT_RULE = [
  "Важно: на старом кадре фона нет — человек или предмет вырезан и вписан в дизайн страницы.",
  "Новый кадр тоже без обстановки: тот же объект целиком, в той же позе и кадрировании,",
  "на ровном чистом белом фоне (#FFFFFF), без пола, теней, стен и предметов вокруг. Это правило важнее правила про обстановку.",
].join(" ");

module.exports = { DEFAULT_REDRAW_RULES, CUTOUT_RULE };
