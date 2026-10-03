const fs=require('fs');const path=require('path');const p=path.join(__dirname,'shell.js');let s=fs.readFileSync(p,'utf8');
s=s.replace("function specialDialog(k){if(k==='todo')", "function specialDialog(k){if(k==='screenshot')return {title:'最新页面截图',html:()=>OWL_PANES.image.html()};if(k==='todo')");
s=s.replace("['close','删除','dialog-delete']", "['close','删除','dialog-deleteFile']");
s=s.replace("'提示词 · 示例'", "'模板 · 示例'");
s=s.replace("if(params.has('focus'))DEMO.focus=true;", "if(params.has('focus'))DEMO.focus=true;\nif(params.has('split')){DEMO.split=true;DEMO.focus=true;}\nif(params.has('navigator'))DEMO.questionNav=true;\nif(params.has('shot'))DEMO.shot=true;");
s=s.replace("'browser-file-submit'].includes(a)", "'browser-file-submit','file-delete-confirm','discard-confirm','file-new-confirm'].includes(a)");
fs.writeFileSync(p,s);
