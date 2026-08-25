**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITSFLMD workstn sfile(SFLR : rrn);
dcl-s rrn packed(4 : 0);
dcl-s i int(10);

RESULT = 'Items 1, 3 and 5 initially selected';
OUTCOUNT = 3;
OUTSCROLL = 0;
*in90 = *on;

for i = 1 to 30;
    rrn = i;
    if i = 17;
        MCTL = 2;
        ITEM = 'Item 17 - unavailable';
    else;
        MCTL = %int(i = 1 or i = 3 or i = 5);
        ITEM = 'Item ' + %trim(%char(i));
    endif;
    write SFLR;
endfor;

dou *in03;
    write FOOT;
    exfmt SFLCTL;
    OUTCOUNT = NUMSEL;
    OUTSCROLL = SCROLLED;
    readc SFLR;
    dow not %eof(ITSFLMD);
        RESULT = %trim(ITEM) + ' state=' + %trim(%char(MCTL));
        readc SFLR;
    enddo;
enddo;

*inlr = *on;
return;
