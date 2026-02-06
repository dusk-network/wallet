import "../public/ui.css";

try {
  document.documentElement.classList.add("dark");
  document.body.dataset.runtime = "web";
  document.body.dataset.view = "app";
} catch {
  // ignore
}

export const parameters = {
  layout: "centered",
};

