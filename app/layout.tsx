import React from 'react';
import NeuralBackground from "./components/NeuralBackground";

export const metadata = {
  title: "Wattmonk RAG Chatbot",
  description: "RAG chatbot with NEC & Wattmonk knowledge, powered by Google Gemini",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial', background: '#050a1a', color: '#f5f7ff' }}>
        <NeuralBackground />
        {children}
      </body>
    </html>
  )
}

