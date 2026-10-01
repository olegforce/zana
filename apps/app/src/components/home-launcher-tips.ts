import type { HelpTip } from './help/help-targets.js';

/** Only controls present in the current launcher receive a dot. */
export const HOME_LAUNCHER_TIPS: readonly HelpTip[] = [
  {
    id: 'cli-agent', selector: '[data-launch-mode="agent"]', title: 'CLI Agent',
    description: 'Open an agent in a terminal, with its familiar command-line interface. Describe a task to get started, or leave the prompt empty for an interactive session.'
  },
  {
    id: 'modern', selector: '[data-launch-mode="thread"]', title: 'Modern',
    description: 'Modern offers the best UX: a clear conversation with messages, tool activity, and agent controls together. It’s also accessible via mobile, so you can continue your conversations on the go.'
  },
  {
    id: 'prompt', selector: '.thread-command-editor-slot', title: 'What would you like to do?', inset: true,
    description: 'Describe the outcome you want, add useful context, and mention files with @. In CLI Agent, you can also leave this empty to open an interactive session.'
  },
  {
    id: 'work-mode', selector: '[data-testid="composer-mode-picker-trigger"]', title: 'Plan or get to work',
    description: 'Choose how the agent approaches your task. Plan is useful for exploring an approach first; Agent gets to work. Some providers offer their own modes here.'
  },
  {
    id: 'model', selector: '[data-testid="model-reasoning-picker-trigger"]', title: 'Pick a model',
    description: 'Choose the provider and model for this task. Where supported, you can also adjust thinking effort: more thinking helps with complex problems, while less is usually faster.'
  },
  {
    id: 'thinking', selector: '[data-testid="reasoning-effort-picker-trigger"]', title: 'Adjust thinking effort',
    description: 'Give the model more time to reason through a difficult task, or choose less thinking for a quicker response. Available levels depend on the model.'
  },
  {
    id: 'send-mode', selector: '[data-testid="composer-send-mode-picker"]', title: 'Choose how follow-ups arrive',
    description: 'While an agent is working, queue a message for its next turn or steer the current turn. Auto queues on Enter and steers on Cmd/Ctrl+Enter; Steer reverses those shortcuts.'
  },
  {
    id: 'squad', selector: 'button[aria-label="Squad"]', title: 'Choose your squad',
    description: 'Pick the team of agents that will work on your goal. Each squad brings its own members and instructions.'
  },
  {
    id: 'squad-plan', selector: 'button[aria-label="Squad planning"]', title: 'Give the squad a plan',
    description: 'Let the squad infer a plan from your goal, or choose to provide a structured plan in the prompt yourself.'
  },
  {
    id: 'options', selector: '.thread-command-options-toggle', title: 'More composer controls',
    description: 'On a smaller screen, open these options to find work mode, thinking, run location, and additional actions.'
  },
  {
    id: 'project', selector: 'button[aria-label="Project"]', title: 'Set the project',
    description: 'Use Default Project for tasks that aren’t tied to anything specific. Zana is smart enough to recognize when your request relates to another project. If you already know which project you want to work on, select it here.'
  },
  {
    id: 'environment', selector: '.environment-picker', title: 'Choose where to work',
    description: 'Work in the project folder, use a separate Git worktree for an isolated change, or choose personal scratch when available.'
  },
  {
    id: 'run-settings', selector: '.mobile-run-settings-trigger', title: 'Choose where to run',
    description: 'Open run settings to choose the machine and working location for this task.'
  },
  {
    id: 'customize', selector: '[data-testid="legacy-agent-customize-launch"]', title: 'Make the launch your own',
    description: 'Choose a persona for reusable instructions, or supply extra CLI arguments when you need a particular launch setup.'
  },
  {
    id: 'permissions', selector: 'button[aria-label="Permission mode"]', title: 'You choose the access',
    description: 'Set how much the agent can do without asking you. Read the choices in this menu and pick the level of access you want for the task.'
  },
  {
    id: 'create-plugin', selector: '[data-testid="composer-create-plugin"]', title: 'Create your own plugin',
    description: 'Add a starter request for building a plugin to your prompt. Describe what you want your plugin to do, then launch the agent to start creating it.'
  },
  {
    id: 'plugin-actions', selector: '.new-thread-plugin-action-list', title: 'Try a shortcut',
    description: 'Installed plugins can add useful starting points here, such as creating your own plugin. Click an action to open its tools.'
  }
];
