/**
 * The terms a borrower accepts before using the system (DES-002). This is a plain-language summary of
 * what the system actually does with their data, written from requirement.md (what is collected, kept
 * permanently on a server in Thailand, no way to edit or delete it inside the system).
 *
 * IT IS A DRAFT: the lender must approve the wording (ideally after legal review) before real
 * borrowers see it. Change the text here; if the wording changes materially, raise PDPA_VERSION in
 * api/src/auth/pdpa.ts as well.
 */
export const PDPA_TITLE = "เงื่อนไขการเก็บและใช้ข้อมูลส่วนบุคคล";

export const PDPA_SECTIONS: ReadonlyArray<{ heading: string; body: string }> = [
  {
    heading: "ข้อมูลที่เก็บ",
    body: "ชื่อ-นามสกุล เบอร์โทรศัพท์ ชื่อธนาคารและเลขบัญชีที่ใช้รับเงิน รวมถึงข้อมูลคำขอยืม สัญญา การรับเงิน และการชำระคืนของท่าน",
  },
  {
    heading: "วัตถุประสงค์",
    body: "เพื่อพิจารณาและจัดการสัญญาเงินยืม โอนเงินให้ท่าน ติดตามการชำระคืน คิดดอกเบี้ยและค่าปรับตามที่ตกลง และทำรายงานภายในของผู้ให้กู้",
  },
  {
    heading: "การเก็บรักษา",
    body: "ข้อมูลเก็บไว้บนเซิร์ฟเวอร์ที่ตั้งอยู่ในประเทศไทย และเก็บไว้ถาวร ระบบไม่ลบข้อมูลโดยอัตโนมัติ",
  },
  {
    heading: "ผู้ที่เข้าถึงข้อมูลได้",
    body: "ผู้ดูแลระบบของผู้ให้กู้เท่านั้น ส่วนท่านเห็นได้เฉพาะข้อมูลของท่านเอง",
  },
  {
    heading: "การขอแก้ไขหรือลบข้อมูล",
    body: "ระบบนี้ไม่มีช่องทางขอแก้ไขหรือลบข้อมูลส่วนบุคคล หากต้องการ กรุณาติดต่อผู้ให้กู้โดยตรง",
  },
  {
    heading: "การยอมรับ",
    body: "ท่านต้องยอมรับเงื่อนไขนี้จึงจะใช้งานระบบได้ ระบบจะบันทึกวันและเวลาที่ท่านยอมรับ",
  },
];
