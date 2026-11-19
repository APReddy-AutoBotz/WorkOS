export const WORKFORCE_DIRECTORY_VERSION='workforce-directory/2';
export const WORKFORCE_DIRECTORY_PAGE_SIZE=20;
export const directoryId=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/u.test(v);
export const directorySearch=v=>typeof v==='string'&&v.length<=100&&v===v.trim()&&!/[\u0000-\u001f\u007f]/u.test(v);
export const directoryLiteral=v=>'%'+v.replace(/[\\%_]/gu,c=>'\\'+c)+'%';
