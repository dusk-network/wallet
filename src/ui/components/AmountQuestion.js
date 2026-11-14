import { h } from "../lib/dom.js";

/**
 * The question an amount that could be read two ways asks, with a button for
 * each reading (amount.js amountChoices): "Is that 2.1250 or 2125?", then
 * "2.1250 DUSK" and "2125 DUSK". A tap gives its reading to `onPick`, for the
 * field to hold; typing stays as it was.
 * @param {{ question: string, choices: Array<{ field: string }> }} asked
 * @param {{ unit?: string, onPick: (field: string) => void }} opts
 * @returns {HTMLElement[]}
 */
export function amountQuestionEls(asked, { unit = "DUSK", onPick }) {
  return [
    h("span", { class: "amount-question__text", text: asked.question }),
    h(
      "span",
      { class: "amount-question__choices" },
      asked.choices.map((choice) =>
        h("button", {
          class: "btn-outline amount-question__choice",
          type: "button",
          text: `${choice.field} ${unit}`,
          onclick: () => onPick(choice.field),
        })
      )
    ),
  ];
}
