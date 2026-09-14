// GENERATED — DO NOT EDIT.
//
// The approved legal text, taken from the sard-legal repository, which is authoritative. Every word
// here is that repository's; nothing in Sard may alter it. Regenerate with:
//
//     node scripts/sync-legal.mjs
//
// and prove it still matches with `--verify`, which the test gate runs.
//
// Revision: terms-1.1+privacy-1.2
// Effective: with the Sard release that asks you to accept them

/** One piece of a legal document — what it is, and what it says. */
export interface LegalBlock {
  k: "eyebrow" | "h1" | "h2" | "lede" | "stamp" | "note" | "p" | "li";
  t: string;
}

export interface LegalDocument {
  version: string;
  en: LegalBlock[];
  ar: LegalBlock[];
}

/** The exact pair of documents a reader is asked to accept. */
export const LEGAL_REVISION = "terms-1.1+privacy-1.2";

/** When this pair takes effect, in the source's own words. */
export const LEGAL_EFFECTIVE = "with the Sard release that asks you to accept them";

/**
 * A fingerprint of the legal content below, so this file can be shown to have been generated
 * rather than edited. Quoted in the application beside the revision, which is what turns "which
 * text did this build carry?" into a question with an answer.
 */
export const LEGAL_CONTENT_HASH = "3b2626c7e5b4d98e2df167f9a1de597b";

export const LEGAL_TERMS: LegalDocument = {
  "version": "1.1",
  "en": [
    {
      "k": "eyebrow",
      "t": "Terms of Service"
    },
    {
      "k": "h1",
      "t": "Using Sard"
    },
    {
      "k": "lede",
      "t": "Sard is a free desktop ebook reader built as a small independent project. These terms are deliberately short: they exist to set expectations, not to intimidate anyone."
    },
    {
      "k": "stamp",
      "t": "Version 1.1 · In effect with the Sard release that asks you to accept them"
    },
    {
      "k": "note",
      "t": "The short version. Sard is free to use for your own reading. The books you open are your business, not ours. The application is offered as it is, with no promises that it is perfect. Please don't sell it, repackage it, or pass it off as your own."
    },
    {
      "k": "h2",
      "t": "1 · Who these terms are between"
    },
    {
      "k": "p",
      "t": "They are between you and the Sard project (\"Sard\", \"we\"). They cover the Sard desktop application, this website, and any official Sard integration with another service. By installing or using Sard you accept them. If you don't, simply don't use it — there is nothing to cancel and no account to close."
    },
    {
      "k": "h2",
      "t": "2 · What you may do"
    },
    {
      "k": "p",
      "t": "You may download, install and use Sard free of charge for your own personal, non-commercial reading, on as many of your own devices as you like. You may look at the source code, and modify it privately for yourself."
    },
    {
      "k": "p",
      "t": "The source code is published under a source-available licence, which is not an open-source licence. The full text is the authority on this, and it is short: read the LICENSE file."
    },
    {
      "k": "h2",
      "t": "3 · What we ask you not to do"
    },
    {
      "k": "li",
      "t": "Don't sell Sard, or charge anyone for it."
    },
    {
      "k": "li",
      "t": "Don't redistribute it, publicly or privately, modified or unmodified — point people at the official releases instead."
    },
    {
      "k": "li",
      "t": "Don't bundle it into another application, or serve its features over a network or an API."
    },
    {
      "k": "li",
      "t": "Don't use the name Sard, the wordmark, or the hoopoe mark to present your own work as ours, or to suggest that we endorse it. Naming Sard to describe where something came from is always fine."
    },
    {
      "k": "h2",
      "t": "4 · Your books are your own"
    },
    {
      "k": "p",
      "t": "Sard does not sell, host, supply or recommend any books. It opens files that are already on your device. You are responsible for the files you import and for having the right to read them, and copyright law applies to them exactly as it did before Sard was involved."
    },
    {
      "k": "h2",
      "t": "5 · Read-aloud and other outside services"
    },
    {
      "k": "p",
      "t": "Sard's read-aloud feature speaks your book using Microsoft's online voice service, which means the text being read is sent to Microsoft while you listen. Using that feature means using their service under their terms as well as these. The Privacy Policy explains exactly what is sent."
    },
    {
      "k": "p",
      "t": "Sard shows what you are reading on your Discord profile, by way of the Discord application already running on your own machine. This is switched on by default. You can switch it off at any time in Sard's settings, under Presence, where four separate controls cover the activity itself, the book's title, the chapter and progress, and the \"browsing the library\" activity shown when no book is open. Leaving it on means using Discord's service under their terms as well as these. The Privacy Policy explains exactly what is sent."
    },
    {
      "k": "h2",
      "t": "6 · Sard is offered as it is"
    },
    {
      "k": "p",
      "t": "Sard is given to you free, with no warranty of any kind, express or implied — including any implied warranty of merchantability, fitness for a particular purpose, or non-infringement. We can't promise it will be uninterrupted, error-free, or right for what you need it for."
    },
    {
      "k": "p",
      "t": "Keep your own backups of anything you would be sorry to lose. Sard stores your library, notes and highlights on your device, and a device can fail for reasons that have nothing to do with us."
    },
    {
      "k": "h2",
      "t": "7 · Limits of responsibility"
    },
    {
      "k": "p",
      "t": "To the fullest extent the law allows, the Sard project and its authors are not liable for any indirect, incidental, special or consequential damages, or for lost data, lost profits, or business interruption, arising out of your use of Sard — even if we were told such damage was possible."
    },
    {
      "k": "p",
      "t": "Nothing here tries to exclude liability that cannot lawfully be excluded, such as liability for death or personal injury caused by negligence, or for fraud."
    },
    {
      "k": "h2",
      "t": "8 · Changes"
    },
    {
      "k": "p",
      "t": "Sard changes as it is developed, and these terms may change with it. When they do, the version number and date at the top of this page change too, and the current text always lives at this address. When a revision requires your agreement, Sard presents it and asks you to accept it before you carry on using the application. Otherwise, continuing to use Sard after a change means accepting the revised terms."
    },
    {
      "k": "h2",
      "t": "9 · If these terms are broken"
    },
    {
      "k": "p",
      "t": "If the terms are broken, the permission granted in section 2 ends. In practice that means stopping use of Sard and deleting your copies of it. Nothing else about your device or your files is affected — we have no access to either."
    },
    {
      "k": "h2",
      "t": "10 · Governing law"
    },
    {
      "k": "p",
      "t": "These terms are governed by the laws of the Kingdom of Saudi Arabia. Any dispute arising out of them, or out of your use of Sard, falls to the competent courts of the Kingdom of Saudi Arabia."
    },
    {
      "k": "p",
      "t": "Nothing in these terms limits any right you have under the consumer law of the country you live in."
    },
    {
      "k": "h2",
      "t": "11 · Getting in touch"
    },
    {
      "k": "p",
      "t": "Questions about these terms, and anything else about Sard, are best raised on the project's issue tracker: github.com/Limitless-Soul1/sard-legal/issues."
    }
  ],
  "ar": [
    {
      "k": "eyebrow",
      "t": "شروط الاستخدام"
    },
    {
      "k": "h1",
      "t": "استعمال سَرْد"
    },
    {
      "k": "lede",
      "t": "سَرْد قارئ كتب إلكترونية مجّاني لسطح المكتب، يقف خلفه مشروع صغير. وهذه الشروط قصيرة عن قصد: غايتها توضيح ما ينبغي توقُّعه، لا تخويف أحد."
    },
    {
      "k": "stamp",
      "t": "الإصدار 1.1 · سارية مع إصدار سَرْد الذي يطلب قبولها"
    },
    {
      "k": "note",
      "t": "باختصار. سَرْد مجّاني لقراءتك الخاصّة. والكتب التي تفتحها شأنك أنت لا شأننا. والتطبيق يُقدَّم كما هو، دون وعد بأنّه خالٍ من العيوب. ونرجو ألّا تبيعه أو تعيد تغليفه أو تنسبه إلى نفسك."
    },
    {
      "k": "h2",
      "t": "١ · بين مَن ومَن"
    },
    {
      "k": "p",
      "t": "هذه الشروط بينك وبين مشروع سَرْد. وهي تشمل تطبيق سَرْد لسطح المكتب، وهذا الموقع، وأيّ تكامل رسميّ بين سَرْد وخدمة أخرى. وباستعمالك سَرْد تقبلها. وإن لم تقبلها فلا تستعمله ببساطة؛ فليس ثمّة اشتراك تُلغيه ولا حساب تُغلقه."
    },
    {
      "k": "h2",
      "t": "٢ · ما يحقّ لك"
    },
    {
      "k": "p",
      "t": "لك أن تُنزّل سَرْد وتُثبّته وتستعمله مجّانًا لقراءتك الشخصية غير التجارية، على ما شئت من أجهزتك. ولك أن تطّلع على شفرته المصدرية وأن تُعدّلها لنفسك في نطاقك الخاصّ."
    },
    {
      "k": "p",
      "t": "الشفرة منشورة برخصة «مصدر متاح»، وهي ليست رخصة مفتوحة المصدر. والنصّ الكامل هو المرجع في ذلك، وهو قصير: اقرأ ملفّ LICENSE."
    },
    {
      "k": "h2",
      "t": "٣ · ما نرجو ألّا تفعله"
    },
    {
      "k": "li",
      "t": "ألّا تبيع سَرْد ولا تتقاضى عنه أجرًا من أحد."
    },
    {
      "k": "li",
      "t": "ألّا تُعيد توزيعه، علنًا أو سرًّا، مُعدَّلًا أو غير مُعدَّل — بل دُلَّ الناس على الإصدارات الرسمية."
    },
    {
      "k": "li",
      "t": "ألّا تُضمّنه في تطبيق آخر، ولا تُقدّم مزاياه عبر شبكة أو واجهة برمجية."
    },
    {
      "k": "li",
      "t": "ألّا تستعمل اسم سَرْد أو شعاره النصّي أو علامة الهُدهُد لتقديم عملك على أنّه عملنا، أو للإيحاء بأنّنا نُزكّيه. أمّا ذكر سَرْد لبيان مصدر شيءٍ ما فمقبول دائمًا."
    },
    {
      "k": "h2",
      "t": "٤ · كتبك ملكك أنت"
    },
    {
      "k": "p",
      "t": "سَرْد لا يبيع كتبًا ولا يستضيفها ولا يوفّرها ولا يوصي بها. هو يفتح ملفّات موجودة أصلًا على جهازك. وأنت المسؤول عن الملفّات التي تستوردها وعن حقّك في قراءتها، ويسري عليها قانون حقوق النشر تمامًا كما كان يسري قبل دخول سَرْد في الأمر."
    },
    {
      "k": "h2",
      "t": "٥ · القراءة الصوتية والخدمات الخارجية"
    },
    {
      "k": "p",
      "t": "تنطق ميزةُ القراءة الصوتية كتابَك عبر خدمة الأصوات من مايكروسوفت، ما يعني أنّ النصّ المقروء يُرسَل إلى مايكروسوفت أثناء استماعك. واستعمال هذه الميزة يعني استعمال خدمتهم بشروطهم إلى جانب شروطنا هذه. وتشرح سياسة الخصوصية ما الذي يُرسَل بالضبط."
    },
    {
      "k": "p",
      "t": "يعرض سَرْد ما تقرؤه على ملفّك الشخصي في Discord، عبر تطبيق Discord العامل أصلًا على جهازك. وهذه الميزة مُفعَّلة افتراضيًّا، ولك أن تُعطّلها متى شئت من إعدادات سَرْد في قسم «الأنشطة»، حيث تشمل أربعةُ مفاتيح منفصلة الميزةَ نفسها، وعنوانَ الكتاب، والفصلَ ونسبةَ التقدّم، ونشاطَ «تصفّح المكتبة» الذي يظهر حين لا يكون ثمّة كتاب مفتوح. وإبقاؤها مُفعَّلة يعني استعمال خدمة Discord بشروطهم إلى جانب شروطنا هذه. وتشرح سياسة الخصوصية ما الذي يُرسَل بالضبط."
    },
    {
      "k": "h2",
      "t": "٦ · سَرْد يُقدَّم كما هو"
    },
    {
      "k": "p",
      "t": "سَرْد يُقدَّم إليك مجّانًا، دون أيّ ضمان من أيّ نوع، صريحٍ كان أو ضمنيًّا — بما في ذلك أيّ ضمان ضمنيّ بالرواج التجاري أو الملاءمة لغرض بعينه أو عدم انتهاك حقوق الغير. ولا يسعنا أن نعِد بأنّه سيعمل بلا انقطاع أو بلا خطأ أو أنّه يناسب ما تريده منه."
    },
    {
      "k": "p",
      "t": "احتفظ بنسخ احتياطية ممّا يُؤسفك فقدُه. فسَرْد يحفظ مكتبتك وملاحظاتك وتظليلاتك على جهازك، والجهاز قد يتعطّل لأسبابٍ لا صلة لنا بها."
    },
    {
      "k": "h2",
      "t": "٧ · حدود المسؤولية"
    },
    {
      "k": "p",
      "t": "إلى أقصى ما يسمح به القانون، لا يتحمّل مشروع سَرْد ولا مؤلّفوه مسؤولية أيّ أضرار غير مباشرة أو عَرَضية أو خاصّة أو تبعية، ولا فقدان بيانات أو أرباح أو تعطّل عمل، ناشئة عن استعمالك سَرْد — حتّى لو كنّا قد أُبلغنا باحتمال وقوع ذلك الضرر."
    },
    {
      "k": "p",
      "t": "وليس في هذه الشروط ما يسعى إلى استبعاد مسؤولية لا يجيز القانون استبعادها، كالمسؤولية عن الوفاة أو الإصابة الجسدية الناجمة عن الإهمال، أو عن الاحتيال."
    },
    {
      "k": "h2",
      "t": "٨ · التغييرات"
    },
    {
      "k": "p",
      "t": "سَرْد يتغيّر مع تطويره، وقد تتغيّر هذه الشروط معه. وحين يحدث ذلك يتغيّر رقم الإصدار وتاريخه في أعلى هذه الصفحة، ويبقى النصّ الساري دائمًا على هذا العنوان. وحين يتطلّب تعديلٌ موافقتَك، يعرضه سَرْد عليك ويطلب قبولك إيّاه قبل أن تُواصل استعمال التطبيق. وفيما عدا ذلك، فاستمرارك في استعمال سَرْد بعد التغيير يعني قبولك الشروط المُعدَّلة."
    },
    {
      "k": "h2",
      "t": "٩ · عند مخالفة الشروط"
    },
    {
      "k": "p",
      "t": "إذا خُولفت هذه الشروط انتهى الإذن الممنوح في البند الثاني. وهذا يعني عمليًّا التوقّف عن استعمال سَرْد وحذف نُسخك منه. ولا يتأثّر شيء آخر في جهازك ولا في ملفّاتك — فلا سبيل لنا إلى أيٍّ منهما."
    },
    {
      "k": "h2",
      "t": "١٠ · القانون الحاكم"
    },
    {
      "k": "p",
      "t": "تخضع هذه الشروط لأنظمة المملكة العربية السعودية، ويكون النظر في أيّ نزاع ينشأ عنها أو عن استعمالك سَرْد للمحاكم المختصّة في المملكة العربية السعودية."
    },
    {
      "k": "p",
      "t": "وليس في هذه الشروط ما يحدّ من أيّ حقّ يكفله لك قانون حماية المستهلك في بلد إقامتك."
    },
    {
      "k": "h2",
      "t": "١١ · للتواصل"
    },
    {
      "k": "p",
      "t": "أفضل مكان لطرح الأسئلة عن هذه الشروط، وعن سَرْد عمومًا، هو صفحة المسائل في مستودع المشروع: github.com/Limitless-Soul1/sard-legal/issues."
    }
  ]
};

export const LEGAL_PRIVACY: LegalDocument = {
  "version": "1.2",
  "en": [
    {
      "k": "eyebrow",
      "t": "Privacy Policy"
    },
    {
      "k": "h1",
      "t": "What Sard knows about you"
    },
    {
      "k": "lede",
      "t": "Almost nothing, and none of it reaches us. Sard is a desktop application with no account system and no server behind it. This page describes precisely what it stores and the only occasions on which it uses the network."
    },
    {
      "k": "stamp",
      "t": "Version 1.2 · In effect with the Sard release that asks you to accept them"
    },
    {
      "k": "note",
      "t": "The short version. Your library, your reading positions, your notes and your highlights are files on your own computer. The Sard project has no server, receives no data, and could not read your library if it wanted to. Two features reach the internet: read-aloud, which sends the text being spoken to Microsoft's voice service, and the update check, which asks GitHub whether a newer version exists. Discord Rich Presence, which is on by default and can be switched off in settings, shows the book you are reading on your Discord profile."
    },
    {
      "k": "h2",
      "t": "1 · What Sard is"
    },
    {
      "k": "p",
      "t": "Sard is a desktop ebook reader for EPUB and PDF files, currently released for Windows. It runs entirely on your computer. There is no Sard account, no Sard server, and no cloud service to sign in to — so there is no place for us to hold information about you even in principle."
    },
    {
      "k": "h2",
      "t": "2 · What Sard stores, and where"
    },
    {
      "k": "p",
      "t": "Everything Sard remembers is written to a folder on your own device. On Windows that folder is:"
    },
    {
      "k": "p",
      "t": "%APPDATA%\\com.sard.app"
    },
    {
      "k": "p",
      "t": "Inside it, Sard keeps:"
    },
    {
      "k": "li",
      "t": "Your books. When you import a file, Sard copies it into that folder so your library does not break when you move the original."
    },
    {
      "k": "li",
      "t": "A database holding your reading positions, bookmarks, highlights, notes, tags, shelves and book details."
    },
    {
      "k": "li",
      "t": "Photo cards you choose to save — images Sard renders from a passage you picked."
    },
    {
      "k": "li",
      "t": "Your settings — theme, typography, reading preferences, chosen voices — and any custom fonts or background images you add yourself."
    },
    {
      "k": "li",
      "t": "Which version of these documents you accepted, and the date you accepted it. Sard keeps this so it only asks you once for each revision."
    },
    {
      "k": "p",
      "t": "This information is stored, not collected. It stays on your device, it is never uploaded, and no part of it is sent to the Sard project or to anyone else."
    },
    {
      "k": "h2",
      "t": "3 · When Sard uses the internet"
    },
    {
      "k": "p",
      "t": "Two features reach the internet, and nothing else. The reading surface itself is sealed off from the network by the application's content security policy, so opening and reading a book never causes a request to leave your machine. A third feature — Discord Rich Presence, in section 4 — does send your reading activity off your device, but by way of the Discord application already running on it rather than by contacting the internet itself."
    },
    {
      "k": "p",
      "t": "Sard's read-aloud voices come from Microsoft's online Edge voice service. While you are listening, Sard sends the passage being read to that service over an encrypted connection and receives spoken audio back. It also fetches the list of available voices so you can choose one."
    },
    {
      "k": "p",
      "t": "This means the text of the book you are listening to leaves your device — that is unavoidable for an online voice, and it is worth knowing before you use the feature. Sard sends no account, no name, no book title and no identifier alongside it, because it has none to send. What Microsoft does with the request is governed by Microsoft's privacy statement, not by this one. If you never use read-aloud, no text ever leaves your device."
    },
    {
      "k": "p",
      "t": "Sard asks GitHub whether a newer release exists — at most once a day while the application is open, and whenever you press the check button yourself. The request reads a small public file from the Sard releases page and contains nothing about you or your library. As with any web request, GitHub can see the IP address it came from."
    },
    {
      "k": "h2",
      "t": "4 · Discord Rich Presence"
    },
    {
      "k": "p",
      "t": "Sard can show your reading activity on your Discord profile: the Sard mark, the title of the book you are reading, and your chapter or your progress through it. While no book is open it shows only that Sard is running."
    },
    {
      "k": "p",
      "t": "This is switched on by default, and you can switch it off at any time in Sard's settings, under Presence. Switching it off takes effect at once — the activity is removed from your Discord profile immediately, rather than lingering until you close the book. Switching it back on restores it without waiting for you to turn a page."
    },
    {
      "k": "p",
      "t": "There are four separate switches, so you can keep the feature on while narrowing what it says: the activity itself, the book's title, the chapter and progress, and the \"browsing the library\" activity shown when no book is open. The first three are enforced inside Sard's core rather than only in its interface, so a switched-off title cannot be sent even in error."
    },
    {
      "k": "p",
      "t": "What is sent is the book's title and your position in it — nothing else. No notes, no highlights, no searches, no file names, and nothing about the rest of your library. Sard passes this to the Discord application running on your own machine; Discord then shows it to whoever can see your profile, and Discord's handling of it is governed by Discord's privacy policy, not by this one. If Discord is not running, Sard sends nothing and nothing is stored anywhere."
    },
    {
      "k": "h2",
      "t": "5 · What Sard never does"
    },
    {
      "k": "li",
      "t": "No accounts, no sign-in, no profiles."
    },
    {
      "k": "li",
      "t": "No analytics, no telemetry, no usage tracking, no crash reporting sent anywhere."
    },
    {
      "k": "li",
      "t": "No advertising, and no advertising identifiers."
    },
    {
      "k": "li",
      "t": "No selling, sharing or licensing of anything about you — we hold nothing to sell."
    },
    {
      "k": "li",
      "t": "No cloud sync. Your library is not copied to any server."
    },
    {
      "k": "li",
      "t": "No reading of your other files. Sard opens the files you give it, and nothing else."
    },
    {
      "k": "h2",
      "t": "6 · You are in control"
    },
    {
      "k": "p",
      "t": "Because everything lives on your device, you do not have to ask us for anything:"
    },
    {
      "k": "li",
      "t": "Delete a book, a note or a highlight inside Sard and it is gone from your database."
    },
    {
      "k": "li",
      "t": "Delete the folder named in section 2 and every trace of your library and settings is gone."
    },
    {
      "k": "li",
      "t": "Uninstalling Sard stops all of the above, including update checks."
    },
    {
      "k": "li",
      "t": "Read-aloud only sends anything while you are actually using it. Not using it sends nothing."
    },
    {
      "k": "p",
      "t": "If you live somewhere with data-protection rights such as access, correction or erasure, those rights are exercised against whoever holds your data — and for your Sard library, that is you. We hold no copy to give you, correct, or delete."
    },
    {
      "k": "h2",
      "t": "7 · Children"
    },
    {
      "k": "p",
      "t": "Sard is suitable for readers of any age and does not collect information from anyone, children included. It has no account system, no messaging, no social features and no advertising."
    },
    {
      "k": "h2",
      "t": "8 · This website"
    },
    {
      "k": "p",
      "t": "These pages are hosted on GitHub Pages. They set no cookies and run no analytics. The only thing stored in your browser is your choice of language and light or dark theme, kept in local storage on your own device so the page remembers it next time."
    },
    {
      "k": "p",
      "t": "The fonts and the images are served from this site itself, so viewing these pages does not contact any third party. GitHub, as the host, may record standard server-log information such as your IP address; that is described in GitHub's privacy statement."
    },
    {
      "k": "h2",
      "t": "9 · Changes to this policy"
    },
    {
      "k": "p",
      "t": "If Sard's behaviour changes, this page changes with it. The version number and date at the top always describe the text below them, and the current version always lives at this address."
    },
    {
      "k": "h2",
      "t": "10 · Getting in touch"
    },
    {
      "k": "p",
      "t": "Questions about privacy in Sard can be raised on the project's issue tracker: github.com/Limitless-Soul1/sard-legal/issues."
    }
  ],
  "ar": [
    {
      "k": "eyebrow",
      "t": "سياسة الخصوصية"
    },
    {
      "k": "h1",
      "t": "ما الذي يعرفه سَرْد عنك"
    },
    {
      "k": "lede",
      "t": "لا شيء تقريبًا، ولا يصل إلينا منه شيء. سَرْد تطبيق لسطح المكتب بلا نظام حسابات ولا خادم خلفه. وتصف هذه الصفحة بدقّة ما الذي يحفظه، والحالات الوحيدة التي يتّصل فيها بالإنترنت."
    },
    {
      "k": "stamp",
      "t": "الإصدار 1.2 · سارية مع إصدار سَرْد الذي يطلب قبولها"
    },
    {
      "k": "note",
      "t": "باختصار. مكتبتك ومواضع قراءتك وملاحظاتك وتظليلاتك ملفّاتٌ على حاسوبك وحده. ومشروع سَرْد لا يملك خادمًا، ولا يستقبل أيّ بيانات، ولا يستطيع قراءة مكتبتك حتّى لو أراد. وثمّة ميزتان تتّصلان بالإنترنت: القراءة الصوتية، وهي تُرسل النصّ المنطوق إلى خدمة الأصوات من مايكروسوفت، والتحقّق من التحديثات، وهو يسأل GitHub إن كان ثمّة إصدار أحدث. أمّا تكامل Discord — وهو مُفعَّل افتراضيًّا ويمكن تعطيله من الإعدادات — فيعرض الكتاب الذي تقرؤه في ملفّك الشخصي على Discord."
    },
    {
      "k": "h2",
      "t": "١ · ما هو سَرْد"
    },
    {
      "k": "p",
      "t": "سَرْد قارئ كتب إلكترونية لسطح المكتب، يفتح ملفّات EPUB وPDF، وهو متاح حاليًّا لنظام ويندوز. يعمل بالكامل على حاسوبك. ولا يوجد حساب في سَرْد، ولا خادم له، ولا خدمة سحابية تُسجّل الدخول إليها — فلا مكان لدينا أصلًا نحفظ فيه معلومات عنك."
    },
    {
      "k": "h2",
      "t": "٢ · ما الذي يحفظه سَرْد وأين"
    },
    {
      "k": "p",
      "t": "كلّ ما يتذكّره سَرْد يُكتب في مجلّد واحد على جهازك. وهذا المجلّد في ويندوز هو:"
    },
    {
      "k": "p",
      "t": "%APPDATA%\\com.sard.app"
    },
    {
      "k": "p",
      "t": "ويحفظ سَرْد داخله:"
    },
    {
      "k": "li",
      "t": "كتبك. عند استيراد ملفّ ينسخه سَرْد إلى ذلك المجلّد، حتّى لا تنكسر مكتبتك إذا نقلتَ الملفّ الأصلي."
    },
    {
      "k": "li",
      "t": "قاعدة بيانات تحوي مواضع قراءتك وفواصلك وتظليلاتك وملاحظاتك ووسومك ورفوفك وتفاصيل كتبك."
    },
    {
      "k": "li",
      "t": "البطاقات المصوّرة التي تختار حفظها — صورٌ يرسمها سَرْد من مقطعٍ تنتقيه."
    },
    {
      "k": "li",
      "t": "إعداداتك — السمة والخطوط وتفضيلات القراءة والأصوات المختارة — وأيّ خطوط أو صور خلفية تضيفها بنفسك."
    },
    {
      "k": "li",
      "t": "أيّ إصدارٍ من هاتين الوثيقتين قبِلتَ، وتاريخ قبولك إيّاه. يحفظ سَرْد ذلك ليسألك مرّةً واحدة عن كلّ إصدار."
    },
    {
      "k": "p",
      "t": "هذه المعلومات محفوظة عندك لا مجموعة عنك. تبقى على جهازك، ولا تُرفَع أبدًا، ولا يُرسَل أيّ جزء منها إلى مشروع سَرْد ولا إلى أيّ جهة أخرى."
    },
    {
      "k": "h2",
      "t": "٣ · متى يستعمل سَرْد الإنترنت"
    },
    {
      "k": "p",
      "t": "ميزتان تتّصلان بالإنترنت لا ثالثة لهما. أمّا سطح القراءة نفسه فمعزول عن الشبكة بسياسة أمن المحتوى في التطبيق، فلا يُسبّب فتحُ كتابٍ وقراءتُه أيّ طلبٍ يغادر جهازك. وثمّة ميزة ثالثة — تكامل Discord في البند ٤ — تُخرج نشاط قراءتك من جهازك، لكن عبر تطبيق Discord العامل عليه لا باتّصالها بالإنترنت بنفسها."
    },
    {
      "k": "p",
      "t": "أصوات القراءة في سَرْد تأتي من خدمة الأصوات من مايكروسوفت عبر الإنترنت. وأثناء استماعك يُرسل سَرْد المقطع المقروء إلى تلك الخدمة عبر اتّصال مُعمّى، ويستقبل منها الصوت المنطوق. كما يجلب قائمة الأصوات المتاحة لتختار منها."
    },
    {
      "k": "p",
      "t": "وهذا يعني أنّ نصّ الكتاب الذي تستمع إليه يغادر جهازك — وهو أمر لا مفرّ منه مع صوتٍ يعمل عبر الإنترنت، ويستحقّ أن تعرفه قبل استعمال الميزة. ولا يُرسل سَرْد معه أيّ حساب ولا اسم ولا عنوان كتاب ولا مُعرّف، إذ لا يملك شيئًا من ذلك أصلًا. وما تفعله مايكروسوفت بهذا الطلب يخضع لبيان الخصوصية الخاصّ بمايكروسوفت لا لهذه السياسة. وإن لم تستعمل القراءة الصوتية قطّ، فلن يغادر جهازك أيّ نصّ."
    },
    {
      "k": "p",
      "t": "يسأل سَرْد موقع GitHub إن كان ثمّة إصدار أحدث — مرّة واحدة في اليوم على الأكثر ما دام التطبيق مفتوحًا، وكلّما ضغطتَ زرّ التحقّق بنفسك. ويقرأ الطلبُ ملفًّا عامًّا صغيرًا من صفحة إصدارات سَرْد، ولا يحمل شيئًا عنك ولا عن مكتبتك. وكما هو الحال في أيّ طلب على الويب، يستطيع GitHub رؤية عنوان IP الذي جاء منه."
    },
    {
      "k": "h2",
      "t": "٤ · تكامل Discord"
    },
    {
      "k": "p",
      "t": "يستطيع سَرْد عرض نشاط قراءتك في ملفّك الشخصي على Discord: علامة سَرْد، وعنوان الكتاب الذي تقرؤه، والفصل الذي أنت فيه أو مقدار ما قطعته منه. وما دام لا كتاب مفتوحًا فلا يظهر إلا أنّ سَرْد يعمل."
    },
    {
      "k": "p",
      "t": "هذه الميزة مُفعَّلة افتراضيًّا، ويمكنك تعطيلها متى شئت من إعدادات سَرْد، في قسم النشاط. والتعطيل يسري فورًا — يُزال النشاط من ملفّك على Discord في الحال، لا عند إغلاق الكتاب. وإعادة تفعيلها تُرجعه دون انتظار انتقالك إلى صفحة جديدة."
    },
    {
      "k": "p",
      "t": "وثمّة أربعة مفاتيح منفصلة، فتُبقي الميزة عاملة وتُضيّق ما تقوله: النشاط نفسه، وعنوان الكتاب، والفصل والتقدّم، ونشاط «تصفّح المكتبة» الذي يظهر حين لا كتاب مفتوحًا. والثلاثة الأولى مطبَّقة في نواة سَرْد لا في واجهته وحدها، فلا يمكن إرسال عنوانٍ عُطِّل إظهاره ولو خطأً."
    },
    {
      "k": "p",
      "t": "والمُرسَل هو عنوان الكتاب وموضعك فيه — لا غير. لا ملاحظات ولا تظليلات ولا عمليات بحث ولا أسماء ملفّات ولا شيء عن بقيّة مكتبتك. ويُسلّم سَرْد ذلك إلى تطبيق Discord العامل على جهازك، ثمّ يعرضه Discord لكلّ من يرى ملفّك الشخصي؛ ويخضع تعامل Discord معها لسياسة الخصوصية الخاصّة بـDiscord لا لهذه السياسة. وإن لم يكن Discord يعمل فلا يُرسِل سَرْد شيئًا ولا يُخزَّن شيء في أيّ مكان."
    },
    {
      "k": "h2",
      "t": "٥ · ما لا يفعله سَرْد أبدًا"
    },
    {
      "k": "li",
      "t": "لا حسابات ولا تسجيل دخول ولا ملفّات شخصية."
    },
    {
      "k": "li",
      "t": "لا تحليلات ولا تتبُّع ولا رصد للاستعمال ولا تقارير أعطال تُرسَل إلى أيّ مكان."
    },
    {
      "k": "li",
      "t": "لا إعلانات ولا مُعرّفات إعلانية."
    },
    {
      "k": "li",
      "t": "لا بيع ولا مشاركة ولا ترخيص لأيّ شيء يخصّك — فلا نملك شيئًا نبيعه."
    },
    {
      "k": "li",
      "t": "لا مزامنة سحابية. مكتبتك لا تُنسَخ إلى أيّ خادم."
    },
    {
      "k": "li",
      "t": "لا اطّلاع على ملفّاتك الأخرى. سَرْد يفتح الملفّات التي تعطيه إيّاها، ولا شيء سواها."
    },
    {
      "k": "h2",
      "t": "٦ · القرار بيدك"
    },
    {
      "k": "p",
      "t": "لأنّ كلّ شيء يعيش على جهازك، فلستَ مضطرًّا إلى طلب أيّ شيء منّا:"
    },
    {
      "k": "li",
      "t": "احذف كتابًا أو ملاحظة أو تظليلًا من داخل سَرْد، يزُل من قاعدة بياناتك."
    },
    {
      "k": "li",
      "t": "احذف المجلّد المذكور في البند الثاني، يزُل كلّ أثر لمكتبتك وإعداداتك."
    },
    {
      "k": "li",
      "t": "إزالة تثبيت سَرْد توقف كلّ ما سبق، بما فيه التحقّق من التحديثات."
    },
    {
      "k": "li",
      "t": "القراءة الصوتية لا تُرسل شيئًا إلّا أثناء استعمالك لها فعلًا. وتركُها يعني ألّا يُرسَل شيء."
    },
    {
      "k": "p",
      "t": "وإن كنت تعيش حيث تكفل لك القوانين حقوقًا في حماية البيانات كالاطّلاع أو التصحيح أو المحو، فهذه الحقوق تُمارَس تجاه من يحتفظ ببياناتك — وفي حالة مكتبة سَرْد، فذاك أنت. ولا نملك نحن نسخةً نُطلعك عليها أو نُصحّحها أو نمحوها."
    },
    {
      "k": "h2",
      "t": "٧ · الأطفال"
    },
    {
      "k": "p",
      "t": "سَرْد صالح للقرّاء من كلّ الأعمار، ولا يجمع معلومات من أحد، والأطفال في ذلك سواء. فليس فيه نظام حسابات ولا مراسلة ولا ميزات اجتماعية ولا إعلانات."
    },
    {
      "k": "h2",
      "t": "٨ · هذا الموقع"
    },
    {
      "k": "p",
      "t": "هذه الصفحات مُستضافة على GitHub Pages. لا تضع أيّ ملفّات تعريف ارتباط ولا تُشغّل أيّ تحليلات. والشيء الوحيد المحفوظ في متصفّحك هو اختيارك للّغة وللسمة الفاتحة أو الداكنة، ويُحفظ في التخزين المحلّي على جهازك لتتذكّره الصفحة في المرّة القادمة."
    },
    {
      "k": "p",
      "t": "والخطوط والصور تُقدَّم من هذا الموقع نفسه، فتصفّح هذه الصفحات لا يتّصل بأيّ طرف ثالث. أمّا GitHub بصفته المستضيف فقد يُسجّل معلومات سجلّات الخوادم المعتادة كعنوان IP، وهو موصوف في بيان الخصوصية الخاصّ بـGitHub."
    },
    {
      "k": "h2",
      "t": "٩ · تغييرات هذه السياسة"
    },
    {
      "k": "p",
      "t": "إذا تغيّر سلوك سَرْد تغيّرت هذه الصفحة معه. ورقم الإصدار وتاريخه في الأعلى يصفان دائمًا النصّ الذي تحتهما، ويبقى النصّ الساري على هذا العنوان."
    },
    {
      "k": "h2",
      "t": "١٠ · للتواصل"
    },
    {
      "k": "p",
      "t": "يمكن طرح الأسئلة المتعلّقة بالخصوصية في سَرْد على صفحة المسائل في مستودع المشروع: github.com/Limitless-Soul1/sard-legal/issues."
    }
  ]
};
