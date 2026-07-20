import { AssistantChat } from "@/components/assistant/AssistantChat";

export default function AiAssistantWidgetPage() {
  return (
    <main className="min-h-dvh bg-transparent">
      <AssistantChat mode="floating" />
    </main>
  );
}

