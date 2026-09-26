import './styles';
import { definePluginApp } from "./compat/app";
import { TasksPanel } from "./shell/panel.js";
import { TasksSidebarAccessory } from "./shell/sidebar-accessory.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: TasksPanel,
    experimental_sidebarAccessory: TasksSidebarAccessory,

  });
  app.slots.threadPanelAction({
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: (props) => <div className="bb-tasks" style={{ height: "100%" }}><TaskEmbedPanel {...props} /></div>,
  });
  app.slots.messageDirective({ id: "task", component: (props) => <div className="bb-tasks"><TaskDirectiveCard {...props} /></div> });
});
