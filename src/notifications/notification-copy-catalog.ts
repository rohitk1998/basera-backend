import type { NotificationEvent } from './notifications.types';

type EventCopy = { title: string; body: string };

/**
 * Backend-owned copy of the `notificationCopy` message namespace from
 * web/messages/*.json. Not imported across the package boundary — this
 * service sends push notifications from a Node process with no active
 * request/cookie, and reaching into a sibling app's directory would break
 * the moment the two are deployed/packaged separately. English + Hindi are
 * kept in sync with the web app's catalog by hand; every other locale
 * falls back to English until reviewed, same convention as
 * web/messages/{locale}.json's `_meta.reviewed` flag.
 */
export const YOUR_LISTING_FALLBACK: Record<string, string> = {
  en: 'your listing',
  hi: 'आपकी लिस्टिंग',
};

export const NOTIFICATION_COPY: Record<string, Partial<Record<NotificationEvent, EventCopy>>> = {
  en: {
    'user.registered': { title: 'Welcome to Basera', body: 'Your account is ready.' },
    'booking.requested': { title: 'New booking request', body: 'Someone wants to stay at {listingTitle}' },
    'booking.confirmed': { title: 'Booking confirmed', body: 'Your stay at {listingTitle} is confirmed' },
    'booking.declined': { title: 'Booking request declined', body: "Your request for {listingTitle} wasn't accepted" },
    'booking.cancelled': { title: 'Booking cancelled', body: 'The booking for {listingTitle} was cancelled' },
    'booking.completed': { title: 'How was your stay?', body: 'Leave a review for {listingTitle}' },
    'booking.payment_held': { title: 'Payment held', body: 'Payment for {listingTitle} is held — your guest is on their way' },
    'booking.checkin_code_ready': { title: 'Check-in code ready', body: 'Give your guest\'s check-in code for {listingTitle} to them in person on arrival' },
    'booking.checked_in': { title: 'Guest checked in', body: '{guestName} checked in at {listingTitle} — payout in 24h unless disputed' },
    'booking.checked_out': { title: 'Stay completed', body: 'The stay at {listingTitle} has been marked as checked out' },
    'booking.disputed': { title: 'Dispute raised', body: '{guestName} raised a dispute for {listingTitle} — Basera is reviewing' },
    'dispute.offer_received': { title: 'Dispute offer received', body: 'A new offer was made on the dispute for {listingTitle}' },
    'dispute.escalated': { title: 'Dispute escalated', body: 'The dispute for {listingTitle} has been sent to Basera for review' },
    'dispute.appeal_raised': { title: 'Dispute appeal filed', body: 'The resolution for {listingTitle} has been appealed' },
    'listing.live': { title: 'Your listing is live', body: '{listingTitle} is now visible to guests' },
    'listing.changes_needed': { title: 'Action needed on your listing', body: '{listingTitle} needs a correction' },
    'message.received': { title: 'New message', body: 'You have a new message on Basera' },
    'call.incoming': { title: 'Incoming call', body: 'Someone is calling you on Basera' },
    'verification.layer_passed': { title: 'Verification passed', body: 'One of your checks cleared' },
    'verification.layer_failed': { title: 'Verification needs another look', body: 'A check needs your attention' },
  },
  hi: {
    'user.registered': { title: 'बसेरा में आपका स्वागत है', body: 'आपका अकाउंट तैयार है।' },
    'booking.requested': { title: 'नया बुकिंग अनुरोध', body: 'कोई {listingTitle} में रुकना चाहता है' },
    'booking.confirmed': { title: 'बुकिंग पुष्ट हुई', body: '{listingTitle} में आपका स्टे पुष्ट हुआ' },
    'booking.declined': { title: 'बुकिंग अनुरोध अस्वीकृत', body: '{listingTitle} के लिए आपका अनुरोध स्वीकार नहीं किया गया' },
    'booking.cancelled': { title: 'बुकिंग रद्द', body: '{listingTitle} के लिए बुकिंग रद्द कर दी गई' },
    'booking.completed': { title: 'आपका स्टे कैसा रहा?', body: '{listingTitle} के लिए एक समीक्षा छोड़ें' },
    'booking.payment_held': { title: 'भुगतान होल्ड हुआ', body: '{listingTitle} के लिए भुगतान होल्ड है — आपका गेस्ट आ रहा है' },
    'booking.checkin_code_ready': { title: 'चेक-इन कोड तैयार है', body: '{listingTitle} के लिए अपने गेस्ट का चेक-इन कोड उन्हें आगमन पर व्यक्तिगत रूप से दें' },
    'booking.checked_in': { title: 'गेस्ट चेक-इन हुआ', body: '{guestName} {listingTitle} में चेक-इन हुआ — 24 घंटे में भुगतान होगा, जब तक विवाद न हो' },
    'booking.checked_out': { title: 'स्टे पूरा हुआ', body: '{listingTitle} पर स्टे पूरा हो गया है' },
    'booking.disputed': { title: 'विवाद दर्ज हुआ', body: '{guestName} ने {listingTitle} के लिए विवाद दर्ज किया — बसेरा समीक्षा कर रहा है' },
    'dispute.offer_received': { title: 'विवाद पर नया प्रस्ताव', body: '{listingTitle} के विवाद पर एक नया प्रस्ताव मिला है' },
    'dispute.escalated': { title: 'विवाद आगे भेजा गया', body: '{listingTitle} का विवाद समीक्षा के लिए बसेरा को भेजा गया है' },
    'dispute.appeal_raised': { title: 'विवाद निर्णय पर अपील', body: '{listingTitle} के समाधान के खिलाफ अपील दर्ज की गई है' },
    'listing.live': { title: 'आपकी लिस्टिंग लाइव है', body: '{listingTitle} अब गेस्ट को दिखाई दे रहा है' },
    'listing.changes_needed': { title: 'आपकी लिस्टिंग पर कार्रवाई आवश्यक', body: '{listingTitle} को सुधार की आवश्यकता है' },
    'message.received': { title: 'नया मैसेज', body: 'आपके पास बसेरा पर एक नया मैसेज है' },
    'call.incoming': { title: 'आने वाली कॉल', body: 'कोई आपको बसेरा पर कॉल कर रहा है' },
    'verification.layer_passed': { title: 'सत्यापन पास हुआ', body: 'आपकी एक जांच पूरी हो गई' },
    'verification.layer_failed': { title: 'सत्यापन को फिर से देखने की आवश्यकता है', body: 'एक जांच पर आपके ध्यान की आवश्यकता है' },
  },
};
