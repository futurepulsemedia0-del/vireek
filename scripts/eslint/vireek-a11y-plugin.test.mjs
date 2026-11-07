import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import plugin from './vireek-a11y-plugin.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } } });
const imp = "import { X, Trash2 } from 'lucide-react';\n";

tester.run('icon-only-name', plugin.rules['icon-only-name'], {
  valid: [
    { code: imp + '<button aria-label="Close"><X /></button>' },
    { code: imp + '<button title="Close"><X /></button>' },
    { code: imp + '<button aria-labelledby="t"><X /></button>' },
    { code: imp + '<button><X /> Close</button>' },
    { code: imp + '<button><X /><span className="sr-only">Close</span></button>' },
    { code: imp + '<button>{t("close")}<X /></button>' },
    { code: imp + '<button {...props}><X /></button>' },
    { code: imp + '<IconButton label="Delete" icon={Trash2} />' },
    { code: '<button><span>Save</span></button>' },
  ],
  invalid: [
    { code: imp + '<button onClick={f}><Trash2 /></button>', errors: [{ messageId: 'missing' }] },
    { code: imp + '<a href="/x"><X /></a>', errors: [{ messageId: 'missing' }] },
    { code: imp + '<Button iconOnly><X /></Button>', errors: [{ messageId: 'missing' }] },
    { code: imp + '<button aria-label=""><X /></button>', errors: [{ messageId: 'missing' }] },
    { code: imp + '<IconButton icon={Trash2} />', errors: [{ messageId: 'missing' }] },
  ],
});

tester.run('no-raw-icon-size', plugin.rules['no-raw-icon-size'], {
  valid: [
    { code: imp + '<X className="icon-sm" />' },
    { code: imp + '<X className="icon-md text-accent" />' },
    { code: imp + '<X size={32} />' }, // display icon
    { code: imp + '<X className="h-10 w-10" />' }, // display icon
    { code: '<div className="h-4 w-4" />' }, // not a lucide element
  ],
  invalid: [
    { code: imp + '<X size={14} />', errors: [{ messageId: 'size' }] },
    { code: imp + '<X size={n} />', errors: [{ messageId: 'size' }] },
    { code: imp + '<X className="h-4 w-4" />', errors: [{ messageId: 'cls' }, { messageId: 'cls' }] },
    { code: imp + '<X className={cn("h-3.5 w-3.5", a)} />', errors: [{ messageId: 'cls' }, { messageId: 'cls' }] },
    { code: imp + '<X className="icon-sm" strokeWidth={2.5} />', errors: [{ messageId: 'stroke' }] },
  ],
});
