/** @type { import('@storybook/html-vite').StorybookConfig } */
export default {
  framework: {
    name: "@storybook/html-vite",
    options: {},
  },
  stories: ["../src/ui/**/*.stories.js"],
  addons: [],
  staticDirs: ["../public"],
};

