import { ThemeProvider } from '@/contexts/ThemeContext';
import { Header } from '@/components/Header';
import { Hero } from '@/components/sections/Hero';
import { Problem } from '@/components/sections/Problem';
import { BeforeAfter } from '@/components/sections/BeforeAfter';
import { Solution } from '@/components/sections/Solution';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { Industries } from '@/components/sections/Industries';
import { LiveDemo } from '@/components/sections/LiveDemo';

function App() {
  return (
    <ThemeProvider>
      <Header />
      <main>
        <Hero />
        <Problem />
        <BeforeAfter />
        <Solution />
        <HowItWorks />
        <Industries />
        <LiveDemo />
      </main>
    </ThemeProvider>
  );
}

export default App;
