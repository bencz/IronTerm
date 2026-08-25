**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITSFLSD workstn sfile(SFLR : rrn);
dcl-s rrn packed(4 : 0);
dcl-s i int(10);
dcl-s changed ind inz(*off);
dcl-s selected ind inz(*off);

RESULT = 'Item 1 is initially selected';
OUTSCROLL = 0;
*in90 = *on;

for i = 1 to 30;
    rrn = i;
    SCTL = %int(i = 1);
    if i = 17;
        SCTL = 2;
        ITEM = 'Item 17 - unavailable';
    else;
        ITEM = 'Item ' + %trim(%char(i));
    endif;
    write SFLR;
endfor;

dou *in03;
    write FOOT;
    exfmt SFLCTL;
    OUTSCROLL = SCROLLED;
    changed = *off;
    selected = *off;
    readc SFLR;
    dow not %eof(ITSFLSD);
        changed = *on;
        if SCTL = 1;
            RESULT = %trim(ITEM) + ' selected';
            selected = *on;
        endif;
        readc SFLR;
    enddo;
    if changed and not selected;
        RESULT = 'Selection changed with no selected item';
    elseif not changed;
        RESULT = 'No selection change';
    endif;
enddo;

*inlr = *on;
return;
