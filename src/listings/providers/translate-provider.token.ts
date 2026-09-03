/** DI token for the active TranslateProvider — bound to SarvamTranslateProvider
 *  today; swap the binding in ListingsModule to route to a different
 *  provider (e.g. Bhashini for specific locales) without touching callers. */
export const TRANSLATE_PROVIDER = Symbol('TRANSLATE_PROVIDER');
