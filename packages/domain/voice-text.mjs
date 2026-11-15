/**
 * Conservative mock text parser, not language understanding or a classifier.
 * Only a single, explicit leading purpose label is accepted. The original
 * transcript remains available when a person needs to choose the purpose.
 */
export function parseVoiceText(text) {
  const transcript = typeof text === 'string' ? text : '';
  const input = transcript.trim();
  const result = { transcript, purpose: null, note: '', reason: 'empty' };
  if (!input) return result;
  const category = label => label.includes('업무') ? 'business' : label === '출퇴근' ? 'commute' : 'personal';
  const labels = [...input.matchAll(/일반\s*업무|업무|출퇴근|개인\s*용도|개인/g)];
  const purposes = new Set(labels.map(match => category(match[0])));
  // Reject uncertainty and negation instead of turning a mention into consent.
  // This mock has no grammatical scope analysis: even a negative memo requires
  // manual purpose confirmation. Match 안/못 as a word or a common negative
  // verb prefix, so place/noun names such as 안산, 안전 and 못골 remain usable.
  const negative = /(?:^|[\s,，:：·])(?:안|못)(?=\s|하|해|했|한|할|합|되|돼|됐|된|썼|쓰|쓴|쓸|갔|가|간|갈|왔|오|온|올|탔|타|탄|탈)|않(?:다|아|았|는|은|을|습|지|고|겠|음)|없(?:다|어|었|는|은|을|습|지|고|겠|음)/u.test(input);
  const uncertain = negative || /아마|아니|아닌|말고|모르|인지|일까|또는|혹은|불확실|애매|(?:것|거)\s*같|맞을까|맞나/.test(input);
  if (purposes.size > 1 || (purposes.size > 0 && uncertain)) return { ...result, reason: 'ambiguous' };
  const prefix = /^(일반\s*업무|업무|출퇴근|개인\s*용도|개인)(?=$|[\s,，:：·])/u.exec(input);
  if (!prefix || purposes.size !== 1) return { ...result, note: input.length <= 120 ? input : '', reason: input.length > 120 ? 'too-long' : purposes.size ? 'ambiguous' : 'missing' };
  const note = input.slice(prefix[0].length).replace(/^[\s,，:：·]+/u, '').trim();
  if (note.length > 120) return { ...result, reason: 'too-long' };
  return { transcript, purpose: category(prefix[0]), note, reason: 'matched' };
}
