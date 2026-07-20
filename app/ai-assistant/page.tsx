import Image from "next/image";
import { AssistantChat, Icon, MeriMascot } from "@/components/assistant/AssistantChat";

const brand = "#c34d50";
const emrnLogoUrl = "https://cdn11.bigcommerce.com/s-rntzxs90f5/images/stencil/500x166/good_logo_1672955118__87815.original.jpg";

const trustItems = [
  {
    icon: "shield" as const,
    title: "Trusted Across Canada",
    copy: "Professional-grade medical supplies you can count on.",
  },
  {
    icon: "truck" as const,
    title: "Fast & Reliable Shipping",
    copy: "Quick delivery across Canada on thousands of products.",
  },
  {
    icon: "leaf" as const,
    title: "Proudly Canadian",
    copy: "Canadian owned and operated.",
  },
  {
    icon: "lock" as const,
    title: "Secure & Private",
    copy: "Your information is handled carefully.",
  },
];

const featureItems = [
  {
    icon: "search" as const,
    title: "Smart Search",
    copy: "Find the right medical supplies quickly using EMRN’s live product catalog.",
  },
  {
    icon: "cart" as const,
    title: "Product Guidance",
    copy: "Compare products, review specifications, check availability, and find suitable alternatives.",
  },
  {
    icon: "quote" as const,
    title: "Request a Quote",
    copy: "Items marked “Contact Us for Quote” cannot be purchased online. Meri will collect the request and send it to the EMRN sales team.",
  },
  {
    icon: "mail" as const,
    title: "Human Support",
    copy: "When Meri cannot confidently help, the customer can send the conversation to EMRN support.",
  },
  {
    icon: "globe" as const,
    title: "Bilingual Support",
    copy: "Communicate in English or français.",
  },
  {
    icon: "kit" as const,
    title: "Medical Product Expertise",
    copy: "Provide factual product information from trusted EMRN catalog and policy data.",
  },
];

export default function AiAssistantPage() {
  return (
    <main className="min-h-screen bg-white text-[#171c26]">
      <section className="mx-auto grid min-h-[720px] max-w-7xl items-center gap-8 px-5 pb-8 pt-7 sm:px-8 lg:grid-cols-[1.02fr_0.98fr] lg:px-10">
        <div className="min-w-0">
          <div className="relative h-[70px] w-[250px] sm:h-[84px] sm:w-[315px]">
            <Image
              src={emrnLogoUrl}
              alt="EMRN Medical Supplies"
              fill
              sizes="(max-width: 640px) 250px, 315px"
              className="object-contain object-left"
              priority
            />
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_230px] lg:items-center">
            <div>
              <div className="text-[13px] font-extrabold uppercase tracking-[0.18em]" style={{ color: brand }}>
                EMRN PULSE
              </div>
              <h1 className="mt-2 max-w-[560px] text-[44px] font-black uppercase leading-[0.95] tracking-normal sm:text-[72px]">
                <span>EMRN</span>
                <span className="block" style={{ color: brand }}>
                  Pulse
                </span>
              </h1>
              <PulseLine className="mt-2 w-56 sm:w-72" />
              <h2 className="mt-4 text-[17px] font-extrabold uppercase tracking-[0.04em]">
                Your AI Medical Supply Assistant
              </h2>
              <p className="mt-4 max-w-lg text-[17px] leading-7 text-[#29313f]">
                Get fast, accurate help finding the right medical supplies for your needs—in English or français.
              </p>
              <div className="mt-6 space-y-3 text-[17px] font-medium">
                <Benefit text="Smart help" />
                <Benefit text="Real people" />
                <Benefit text="Right products" />
              </div>
            </div>

            <div className="emrn-pulse-hero-mascot mx-auto hidden w-full max-w-[260px] lg:block">
              <MeriMascot className="h-[260px] w-[260px]" />
            </div>
          </div>

          <div className="mt-8 max-w-[530px] rounded-[8px] border border-[#f1e6e3] bg-[#fff8f7] p-5 shadow-[0_12px_28px_rgba(23,28,38,0.06)] sm:flex sm:items-center sm:gap-5">
            <div className="mb-4 flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[#f7e8e5] text-[#c34d50] sm:mb-0">
              <Icon name="heart" />
            </div>
            <div>
              <div className="font-serif text-[30px] italic leading-tight" style={{ color: brand }}>
                Meet Meri
              </div>
              <div className="mt-1 text-[17px] font-extrabold">Your EMRN AI Assistant</div>
              <p className="mt-2 text-[16px] leading-6 text-[#29313f]">
                Hi! I’m Meri. I’m here to help you find products, compare options, request quotes, and answer your questions.
              </p>
            </div>
          </div>
        </div>

        <div className="mx-auto w-full max-w-[480px] lg:max-w-[520px]">
          <AssistantChat mode="embedded" />
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-10 sm:px-8 lg:px-10">
        <div className="grid overflow-hidden rounded-[8px] border border-[#eadfdd] bg-white shadow-[0_8px_24px_rgba(23,28,38,0.05)] md:grid-cols-4">
          {trustItems.map((item, index) => (
            <div key={item.title} className={`flex gap-4 p-5 ${index ? "border-t border-[#eadfdd] md:border-l md:border-t-0" : ""}`}>
              <div className="mt-1 text-[#c34d50]">
                <Icon name={item.icon} />
              </div>
              <div>
                <h3 className="text-[15px] font-extrabold">{item.title}</h3>
                <p className="mt-1 text-[13px] leading-5 text-[#4b5563]">{item.copy}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-10 sm:px-8 lg:px-10">
        <h2 className="text-center text-[26px] font-black tracking-normal sm:text-[30px]">
          What <span className="font-serif italic" style={{ color: brand }}>Meri</span> Can Help You With
        </h2>
        <div className="mx-auto mt-2 h-px w-48 bg-[#eadfdd]" />

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {featureItems.map((item) => (
            <article key={item.title} className="rounded-[8px] border border-[#eadfdd] bg-white p-5 text-center shadow-[0_10px_24px_rgba(23,28,38,0.05)]">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#f8ebe8] text-[#c34d50]">
                <Icon name={item.icon} />
              </div>
              <h3 className="mt-4 text-[15px] font-extrabold">{item.title}</h3>
              <p className="mt-2 text-[13px] leading-5 text-[#29313f]">{item.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-10 sm:px-8 lg:px-10">
        <div className="grid gap-5 rounded-[8px] border border-[#e6aaa3] bg-white p-5 shadow-[0_8px_24px_rgba(23,28,38,0.04)] md:grid-cols-[260px_1fr] md:items-center">
          <div className="flex items-center gap-4">
            <MeriMascot className="h-24 w-24 shrink-0" />
            <div>
              <h2 className="text-[23px] font-black leading-tight">Here to Help, Every Step of the Way</h2>
              <p className="mt-2 text-[14px] leading-5 text-[#4b5563]">
                From product recommendations to quote requests, EMRN Pulse is your smart partner for medical supplies.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Proof icon="spark" title="Always Improving" copy="I learn from requests so the team can improve answers." />
            <Proof icon="shield" title="Accurate & Reliable" copy="Information comes directly from EMRN’s trusted data." />
            <Proof icon="people" title="Real People" copy="Backed by our expert team when you need us." />
          </div>
        </div>
      </section>

      <AssistantChat mode="floating" />
    </main>
  );
}

function Benefit({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#c34d50] text-sm font-bold text-white">✓</span>
      <span>{text}.</span>
    </div>
  );
}

function Proof({ icon, title, copy }: { icon: "spark" | "shield" | "people"; title: string; copy: string }) {
  return (
    <div className="flex gap-3 border-t border-[#eadfdd] pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
      <div className="text-[#c34d50]">
        <Icon name={icon} />
      </div>
      <div>
        <h3 className="text-[14px] font-extrabold">{title}</h3>
        <p className="mt-1 text-[13px] leading-5 text-[#4b5563]">{copy}</p>
      </div>
    </div>
  );
}

function PulseLine({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 220 42" fill="none" aria-hidden="true">
      <path d="M2 22h62l9-18 15 36 13-26 9 8h44l7-12 13 24 8-12h36" stroke="#c34d50" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="214" cy="22" r="6" fill="#c34d50" />
    </svg>
  );
}
