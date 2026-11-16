from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

F="Arial"; BLUE=Font(name=F,color="0000FF"); BLK=Font(name=F); B=Font(name=F,bold=True); H=Font(name=F,bold=True,color="FFFFFF")
HF=PatternFill("solid",fgColor="1F4E3D"); TOT=PatternFill("solid",fgColor="E8F0EC"); YEL=PatternFill("solid",fgColor="FFF2CC")
thin=Side(style="thin",color="BFBFBF"); BOX=Border(left=thin,right=thin,top=thin,bottom=thin)
MON='#,##0.00;(#,##0.00);"-"'
D="https://drive.google.com/file/d/{}/view"

inv=[ # id, date, supplier, vat, invno, type, city, pay, sender, sent, file, notes, printed_total
 ("F1","2026-11-05","شركة ثلاجة أجاويد للتجارة","311376880600003","71758","فاتورة ضريبية","الأحساء","نقدي","سليمان","2026-11-10","13FlvTmkTiw9An8D8FDTsmCp48ivJIzFE","مدفوعة كاملة كاش من درج الكاشير (أكده حسن 16 نوفمبر)، مع إن المطبوع عليها «مدفوعة جزئيًا»؛ رقمنا الضريبي مذكور عليها. س.ت المورد 7005852970",833.75),
 ("F2","2026-11-07","شركة على كيفك - فرع الأحساء","310496523610003","196590","فاتورة ضريبية مبسطة","الأحساء","نقدي","سليمان","2026-11-10","1uKlS977qMZd6Pcj1RUbNrLG_I9wUPOx1","فاتورة نقدية، 22:29",149.85),
 ("F3","2026-11-07","أسواق نجمة غيوم للتجارة","312822364100003","64260","فاتورة ضريبية مبسطة","الأحساء - النايفية","نقدي","سليمان","2026-11-10","1uKlS977qMZd6Pcj1RUbNrLG_I9wUPOx1","في نفس صورة فاتورة «على كيفك»",8.00),
 ("F4","2026-11-07","مؤسسة نوف فهد بن حمد الركيان","","100011202611070000014","إيصال بدون ضريبة","الأحساء - النايفية","نقدي","سليمان","2026-11-10","1CuKem67KNGl7JbgxFrMjQypTefXc4Ner","الرقم الضريبي فاضي في الإيصال والضريبة 0. س.ت 2251501997",10.00),
 ("F5","2026-11-08","ظل التوفير - فرع الأحساء","302005929900003","247080","فاتورة ضريبية مبسطة","الأحساء - النايفية","نقدي","سليمان","2026-11-10","1MO4jDjIgYNV4QVaXXKDCl8ed_rVWIRH7","فاتورة نقدية 21:45. الكميات بالوزن محسوبة من المبلغ ÷ السعر",62.79),
 ("F6","2026-11-11","نايف ألفا للطباعة (NAIF ALFA PRINT)","300828106900003","05323","فاتورة ضريبية","الرياض","تحويل","حسن","2026-11-11","1kcDpNyMexkCX8smeDrnhXxRpJC9Kdjld","موجهة لمؤسسة ميني جيش برقمنا الضريبي؛ مدفوعة بالكامل 9,228. مدة التوريد 15–20 يوم عمل",9228.00),
 ("F7","2026-11-12","شركة أحمد سعد بوسعد التجارية - بو سعد للبلاستيك","311021825200003","26400600219119","فاتورة ضريبية مبسطة","الأحساء - الهفوف (فرع الخالدية)","شبكة","حسن","2026-11-12","1HgFoz4wr9idwxtRkpdiP0DuUIyKyH1Vk","اسم مؤسستنا ورقمنا الضريبي عليها. الدفع شبكة (أكده حسن 16 نوفمبر)",375.00),
 ("F8","2026-11-13","أسواق نجمة غيوم للتجارة","312822364100003","66348","فاتورة ضريبية مبسطة","الأحساء - النايفية","نقدي","سليمان","2026-11-14","1C4UNpg7Rg8GISup3ipLZ3pBFg3O4nLoU","01:19 ص",16.00),
 ("F9","2026-11-13","ظل التوفير - فرع الأحساء","302005929900003","245210","فاتورة ضريبية مبسطة","الأحساء - النايفية","نقدي","سليمان","2026-11-14","1JgZQm5vFUNTotPD9F7BIqsl8NjECC65Z","فاتورة نقدية 21:53. الكميات بالوزن محسوبة من المبلغ ÷ السعر",49.82),
 ("F10","2026-11-14","شركة ثلاجة أجاويد للتجارة","311376880600003","72766","فاتورة ضريبية","الأحساء","نقدي","سليمان","2026-11-15","1QQeQz7hKcAO4KkM4j6P4cQfHshdN462Z","مدفوعة كاش (أكده حسن 16 نوفمبر)، مع إن الفاتورة مطبوع عليها «غير مدفوعة». رقم العميل 000873. باسم مؤسستنا ورقمنا الضريبي",652.05),
]
lines=[ # inv, item, category, qty, unit, unit_price, discount, amount_as_printed, incl_vat?, rate
 ("F1","صدور دجاج ستيورة 4×2.5 كجم","دواجن ولحوم",3,"كرتون",180,0,540,"لا",0.15),
 ("F1","طحين فاخر كيلة 45 كجم","خامات ودقيق",5,"كيس",37,0,185,"لا",0.15),
 ("F2","رويال صواني فرن مربع 41×29×5 سم","أدوات مطبخ",3,"حبة",49.95,0,149.85,"نعم",0.15),
 ("F3","مياه نانا 5 جالون","تشغيل ومستهلكات",1,"حبة",8,0,8,"نعم",0.15),
 ("F4","سيليكون ألماني","صيانة",1,"حبة",10,0,10,"لا",0),
 ("F5","جزر","خضار",2.282,"كجم",7.95,0,18.14,"نعم",0.15),
 ("F5","ليمون أصفر عبوة شربتلي","خضار",0.794,"كجم",6.95,0,5.52,"نعم",0.15),
 ("F5","فلفل بارد","خضار",2.556,"كجم",5.85,0,14.95,"نعم",0.15),
 ("F5","بصل","خضار",12.4,"كجم",1.95,0,24.18,"نعم",0.15),
 ("F6","علبة متصلة بدون شفاف مع سلوفان 36×10×5","تغليف",1500,"حبة",1.30,0.16,1949.84,"لا",0.15),
 ("F6","علبة متصلة بدون شفاف مع سلوفان 36×17.5×4.5","تغليف",1500,"حبة",1.40,0.17,2099.83,"لا",0.15),
 ("F6","علبة ميني كرواسون طباعة وجهين مع سلوفان لصق متصل","تغليف",1500,"حبة",2.65,0.32,3974.68,"لا",0.15),
 ("F7","صحن مدور ذهبي 40° الرواد 5ح JS-S12","تغليف",1,"كرتون",375,0,375,"نعم",0.15),
 ("F8","مياه نانا 5 جالون","تشغيل ومستهلكات",1,"حبة",8,0,8,"نعم",0.15),
 ("F8","حليب المراعي كامل الدسم 250 جم","ألبان وأجبان",2,"حبة",4,0,8,"نعم",0.15),
 ("F9","باذنجان أسود","خضار",round(3.82/1.95,3),"كجم",1.95,0,3.82,"نعم",0.15),
 ("F9","بصل","خضار",round(16.98/1.95,3),"كجم",1.95,0,16.98,"نعم",0.15),
 ("F9","فلفل بارد","خضار",round(8.36/5.95,3),"كجم",5.95,0,8.36,"نعم",0.15),
 ("F9","ليمون أصفر عبوة شربتلي","خضار",round(2.96/6.95,3),"كجم",6.95,0,2.96,"نعم",0.15),
 ("F9","طماطم محمي","خضار",round(13.80/4.95,3),"كجم",4.95,0,13.80,"نعم",0.15),
 ("F9","ثوم 500 جرام","خضار",2,"حبة",1.95,0,3.90,"نعم",0.15),
 ("F10","جبن كريمي تشيز كيك كيري 12×1 كجم","ألبان وأجبان",1,"كرتون",415,0,415,"لا",0.15),
 ("F10","لبنة داري 4×2.700 كجم","ألبان وأجبان",1,"كرتون",152,0,152,"لا",0.15),
]
pending=[]

wb=Workbook()
def sheet(ws,headers,widths):
    ws.sheet_view.rightToLeft=True
    for i,(h,w) in enumerate(zip(headers,widths),1):
        c=ws.cell(1,i,h); c.font=H; c.fill=HF; c.alignment=Alignment(horizontal="center",vertical="center",wrap_text=True); c.border=BOX
        ws.column_dimensions[get_column_letter(i)].width=w
    ws.row_dimensions[1].height=34; ws.freeze_panes="A2"

# ---- lines
L=wb.active; L.title="الأصناف"
sheet(L,["رقم داخلي","رقم فاتورة المورد","المورد","تاريخ الفاتورة","الصنف","التصنيف","الكمية","الوحدة","سعر الوحدة كما في الفاتورة","الخصم","المبلغ كما في الفاتورة","المبلغ شامل الضريبة؟","نسبة الضريبة","قبل الضريبة","الضريبة","الإجمالي شامل الضريبة"],
      [10,22,32,13,42,16,10,9,14,9,14,12,10,13,12,15])
invd={x[0]:x for x in inv}
for r,(iid,item,cat,q,u,p,disc,amt,incl,rate) in enumerate(lines,2):
    vals=[iid,f"=INDEX('الفواتير'!E:E,MATCH(A{r},'الفواتير'!A:A,0))",f"=INDEX('الفواتير'!C:C,MATCH(A{r},'الفواتير'!A:A,0))",f"=INDEX('الفواتير'!B:B,MATCH(A{r},'الفواتير'!A:A,0))",item,cat,q,u,p,disc,amt,incl,rate,
          f'=IF(L{r}="نعم",ROUND(K{r}/(1+M{r}),2),K{r})',f'=IF(L{r}="نعم",K{r}-N{r},ROUND(N{r}*M{r},2))',f"=N{r}+O{r}"]
    for c,v in enumerate(vals,1):
        cell=L.cell(r,c,v); cell.border=BOX; cell.font=BLUE if c in (1,5,6,7,8,9,10,11,12,13) else BLK
    for c in (9,10,11,14,15,16): L.cell(r,c).number_format=MON
    L.cell(r,13).number_format="0%"; L.cell(r,7).number_format="#,##0.###"; L.cell(r,4).number_format="yyyy-mm-dd"
n=len(lines)+1; t=n+1
L.cell(t,5,"الإجمالي").font=B
for c in (14,15,16):
    col=get_column_letter(c); x=L.cell(t,c,f"=SUM({col}2:{col}{n})"); x.font=B; x.number_format=MON; x.fill=TOT
dv=DataValidation(type="list",formula1='"نعم,لا"',allow_blank=False); L.add_data_validation(dv); dv.add(f"L2:L{n+50}")
L.cell(2,7).comment=Comment("الأوزان (كجم) في فاتورة ظل التوفير محسوبة: المبلغ ÷ سعر الكيلو، لأن الفاتورة مطبوعة بالوزن المختصر.","Claude")
L.cell(t+2,1,"دليل: الخانات الزرقاء منقولة من صورة الفاتورة (تُعدَّل إذا لزم)، والسوداء معادلات. «المبلغ كما في الفاتورة» هو مبلغ السطر المطبوع: شامل الضريبة في الفواتير المبسطة، وقبل الضريبة في الفواتير الضريبية.").font=Font(name=F,italic=True,color="595959")

# ---- invoices
I=wb.create_sheet("الفواتير",0)
sheet(I,["رقم داخلي","تاريخ الفاتورة","المورد","الرقم الضريبي للمورد","رقم فاتورة المورد","نوع الفاتورة","المدينة","قبل الضريبة","ضريبة القيمة المضافة","الإجمالي شامل الضريبة","الإجمالي المطبوع في الفاتورة","الفرق","طريقة الدفع","أرسلها","تاريخ الإرسال","صورة الفاتورة","ملاحظات للمحاسب"],
      [10,13,34,20,22,20,18,14,14,15,15,9,14,10,13,14,60])
for r,(iid,d,sup,vat,no,typ,city,pay,snd,sent,fid,note,printed) in enumerate(inv,2):
    vals=[iid,d,sup,vat,no,typ,city,f"=SUMIFS('الأصناف'!N:N,'الأصناف'!A:A,A{r})",f"=SUMIFS('الأصناف'!O:O,'الأصناف'!A:A,A{r})",f"=H{r}+I{r}",printed,f"=ROUND(J{r}-K{r},2)",pay,snd,sent,"فتح الصورة",note]
    for c,v in enumerate(vals,1):
        cell=I.cell(r,c,v); cell.border=BOX; cell.font=BLUE if c in (1,2,3,4,5,6,7,11,13,14,15,17) else BLK
        cell.alignment=Alignment(vertical="top",wrap_text=(c==17))
    I.cell(r,16).hyperlink=D.format(fid); I.cell(r,16).font=Font(name=F,color="0563C1",underline="single")
    for c in (8,9,10,11,12): I.cell(r,c).number_format=MON
    if pay=="يحتاج تأكيد": I.cell(r,13).fill=YEL
m=len(inv)+1; t=m+1
I.cell(t,3,"الإجمالي").font=B
for c in (8,9,10,11,12):
    col=get_column_letter(c); x=I.cell(t,c,f"=SUM({col}2:{col}{m})"); x.font=B; x.number_format=MON; x.fill=TOT
dvp=DataValidation(type="list",formula1='"نقدي,تحويل,آجل,شبكة,يحتاج تأكيد"'); I.add_data_validation(dvp); dvp.add(f"M2:M{m+50}")
I.cell(t+2,1,"الفرق = الإجمالي المحسوب من الأصناف − المطبوع في الفاتورة؛ لازم يكون صفر. المشتري في الفواتير الضريبية: مؤسسة ميني جيش، الرقم الضريبي 313014584600003.").font=Font(name=F,italic=True,color="595959")

# ---- summary
S=wb.create_sheet("الملخص",0); S.sheet_view.rightToLeft=True
for col,w in zip("ABCDE",[34,15,15,17,10]): S.column_dimensions[col].width=w
S["A1"]="مشتريات نوفمبر 2026 — مؤسسة ميني جيش (مينيقيش)"; S["A1"].font=Font(name=F,bold=True,size=14)
S["A2"]="من فواتير المشتريات المرسلة لرقم اللوحة؛ الأرقام بالريال وشاملة الضريبة حيث ذُكر"; S["A2"].font=Font(name=F,italic=True,color="595959")
def block(row,title,keys,keycol):
    for i,h in enumerate([title,"قبل الضريبة","الضريبة","الإجمالي شامل","عدد"],1):
        c=S.cell(row,i,h); c.font=H; c.fill=HF; c.border=BOX
    r=row+1
    for k in keys:
        S.cell(r,1,k).font=BLK
        if keycol=="sup":
            S.cell(r,2,f"=SUMIFS('الفواتير'!H:H,'الفواتير'!C:C,A{r})"); S.cell(r,3,f"=SUMIFS('الفواتير'!I:I,'الفواتير'!C:C,A{r})"); S.cell(r,5,f"=COUNTIFS('الفواتير'!C:C,A{r})")
        elif keycol=="pay":
            S.cell(r,2,f"=SUMIFS('الفواتير'!H:H,'الفواتير'!M:M,A{r})"); S.cell(r,3,f"=SUMIFS('الفواتير'!I:I,'الفواتير'!M:M,A{r})"); S.cell(r,5,f"=COUNTIFS('الفواتير'!M:M,A{r})")
        else:
            S.cell(r,2,f"=SUMIFS('الأصناف'!N:N,'الأصناف'!F:F,A{r})"); S.cell(r,3,f"=SUMIFS('الأصناف'!O:O,'الأصناف'!F:F,A{r})"); S.cell(r,5,f"=COUNTIFS('الأصناف'!F:F,A{r})")
        S.cell(r,4,f"=B{r}+C{r}")
        for c in range(1,6): S.cell(r,c).border=BOX
        for c in (2,3,4): S.cell(r,c).number_format=MON
        r+=1
    S.cell(r,1,"الإجمالي").font=B
    for c in (2,3,4,5):
        col=get_column_letter(c); x=S.cell(r,c,f"=SUM({col}{row+1}:{col}{r-1})"); x.font=B; x.fill=TOT; x.border=BOX
        if c<5: x.number_format=MON
    return r+2
sups=sorted({x[2] for x in inv}); cats=sorted({x[2] for x in lines}); pays=sorted({x[7] for x in inv})
r=block(4,"المورد",sups,"sup"); r=block(r,"التصنيف",cats,"cat"); r=block(r,"طريقة الدفع",pays,"pay")
S.cell(r,1,"ضريبة المدخلات في الفواتير الضريبية الكاملة (باسم المؤسسة ورقمها الضريبي)").font=B
S.cell(r,4,"=SUMIFS('الفواتير'!I:I,'الفواتير'!F:F,\"فاتورة ضريبية\")").number_format=MON; S.cell(r,4).font=B
S.cell(r+1,1,"ضريبة الفواتير المبسطة (إيصالات المحلات)").font=BLK
S.cell(r+1,4,"=SUMIFS('الفواتير'!I:I,'الفواتير'!F:F,\"فاتورة ضريبية مبسطة\")").number_format=MON
S.cell(r+2,1,"قرار خصم ضريبة المدخلات واعتماد الفواتير المبسطة يرجع للمحاسب.").font=Font(name=F,italic=True,color="595959")
if pending: S.cell(r+4,1,f"⚠ {len(pending)} فواتير وصلت وما انقرت بعد (تنحفظ صورها الليلة) — في تبويب «بانتظار القراءة»").font=Font(name=F,bold=True,color="C00000")

# ---- pending
if pending:
    P=wb.create_sheet("بانتظار القراءة")
    sheet(P,["وقت الإرسال","أرسلها","طريقة الدفع","النص المرفق","الحالة"],[18,10,13,32,40])
    for r,(t_,s,p,txt) in enumerate(pending,2):
        for c,v in enumerate([t_,s,p,txt,"الصورة تنحفظ في درايف 15–16 نوفمبر الساعة 2:15 ص، وبعدها تنضاف هنا"],1):
            x=P.cell(r,c,v); x.font=BLK; x.border=BOX
for ws in wb.worksheets:
    for row in ws.iter_rows():
        for c in row:
            if c.font and c.font.name!=F: c.font=Font(name=F,bold=c.font.bold,italic=c.font.italic,color=c.font.color,size=c.font.size,underline=c.font.underline)
wb.save("مشتريات_نوفمبر_2026.xlsx")
