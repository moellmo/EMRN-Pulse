import { AssistantChat } from "@/components/assistant/AssistantChat";

export default function AiAssistantWidgetPage() {
  return (
    <main className="emrn-pulse-widget-shell">
      <AssistantChat mode="floating" />
    </main>
  );
}
